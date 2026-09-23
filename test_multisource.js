/**
 * 多源（踩点 + Knot/GAS 物料激励）冒烟测试
 * 用法：NODE_PATH=...node/workspace/node_modules node test_multisource.js
 * 前置：knot-map 目录已启动 http server（127.0.0.1:8123）
 * ※ 数据源通过 ?sources= 参数传入，不依赖本地 config.js 的内容
 */
const { chromium } = require("playwright");

const SOURCES = encodeURIComponent(JSON.stringify([
  { label: "踩点データ（Sheets）", url: "asakusa.csv" },
  { label: "物料激励＋子商户进件（Knot）", url: "knot_sample.json" }
]));
const URL = process.env.TEST_URL || "http://127.0.0.1:8123/points.html?sources=" + SOURCES;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (label, cond, extra) => {
    if (cond) { pass++; console.log("  [OK]   " + label); }
    else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
  };

  console.log("\n=== 多源読み込み: " + URL + " ===");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById("s-total");
    return t && /\d/.test(t.textContent || "");
  }, { timeout: 20000 }).catch(() => console.log("  (警告) 20s 内に件数が出ませんでした"));
  await page.waitForTimeout(2500);

  // 1) 件数 = 1598(asakusa.csv) + 12(knot_sample.json) = 1610
  const total = parseInt(((await page.textContent("#s-total")) || "0").replace(/[^\d]/g, ""), 10);
  console.log("  総件数:", total);
  check("2ソース合算 1610 件", total === 1610, total);

  // 2) ソース一覧が2つ出ている
  const srcItems = await page.$$eval("#srcList .lg", els =>
    els.map(e => ({ label: e.textContent.trim(), off: e.classList.contains("off") })));
  console.log("  ソース:", JSON.stringify(srcItems));
  check("ソース一覧が2件表示", srcItems.length === 2, srcItems);
  check("両方とも取得成功（失敗表示なし）", srcItems.every(s => !/失敗/.test(s.label)), srcItems);

  // 3) 片方をOFFにすると件数が減る
  await page.click("#srcList .lg:nth-child(2)");
  await page.waitForTimeout(800);
  const shownAfter = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  console.log("  KnotソースOFF後の表示中:", shownAfter);
  check("片方OFFで表示数が減る（1598）", shownAfter === 1598, shownAfter);

  // 4) 最后一个ソースはOFFにできない（全部空白にしない安全弁）
  await page.click("#srcList .lg:nth-child(1)");
  await page.waitForTimeout(800);
  const shownGuard = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  check("最後1つはOFF不可（0件事故を防ぐ）", shownGuard === 1598, shownGuard);

  // 5) Knot をONに戻してから踩点をOFF → 12件
  await page.click("#srcList .lg:nth-child(2)");
  await page.waitForTimeout(500);
  await page.click("#srcList .lg:nth-child(1)");
  await page.waitForTimeout(800);
  const shownA = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  console.log("  踩点OFF / Knot ON の表示中:", shownA);
  check("逆にすると12件", shownA === 12, shownA);

  // 6) 両方ONに戻す
  await page.click("#srcList .lg:nth-child(1)");
  await page.waitForTimeout(600);

  // 6) 凡例がカテゴリで分かれている
  const legend = await page.$$eval("#legend .lg", els => els.map(e => e.textContent.trim()));
  console.log("  凡例:", JSON.stringify(legend.slice(0, 8)));
  check("凡例が1件以上ある", legend.length >= 1, legend.length);

  // 7) ピンが描画されている（Leaflet の circleMarker 数）
  const pins = await page.evaluate(() => document.querySelectorAll("#map path.leaflet-interactive").length);
  console.log("  描画ピン数:", pins);
  check("ピンが描画されている", pins > 0, pins);

  // 8) JS エラーなし
  const realErr = errors.filter(e => !/favicon|net::ERR_|Failed to load resource/i.test(e));
  check("JS エラーなし", realErr.length === 0, realErr);

  await page.screenshot({ path: "smoke_multisource.png", fullPage: false });
  console.log("\n  結果: " + pass + " passed / " + fail + " failed");
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
