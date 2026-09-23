/**
 * 踩点表（Google Sheets 发布 CSV）真实链路冒烟测试
 * 用法：NODE_PATH=/Users/annika/.workbuddy/binaries/node/workspace/node_modules node test_spot_live.js
 * 前置：knot-map 目录下已启动 http server（python3 -m http.server 8123）
 * 依赖外网（拉真实发布 CSV），失败时先确认 Sheets 仍处于「发布到网络」状态。
 *
 * 验证点：LatLng 合并列能正确拆分（坐标落在日本范围内）、ShopName 能识别、Industry 能当分类
 */
const { chromium } = require("playwright");

const CSV_URL = process.env.SPOT_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTflfloJoLCv0H--qT8tsu4AfvpbAmQyE9wEbCso7dWTj3rYrwHzbzehU8ZKoXzyfK9FuMh_qSrIB7P/pub?gid=0&single=true&output=csv";
const URL = "http://127.0.0.1:8123/points.html?sources=" +
  encodeURIComponent(JSON.stringify([{ label: "踩点データ", url: CSV_URL }]));

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

  console.log("\n=== 踩点表 live 冒烟 ===");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById("s-total");
    return t && /\d/.test(t.textContent || "");
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const total = parseInt(((await page.textContent("#s-total")) || "0").replace(/[^\d]/g, ""), 10);
  check("页面加载数据 > 2000 件", total > 2000, total);

  // 直接在页面上下文里复用 loadRows/normalize，逐项体检
  const audit = await page.evaluate(async (csvUrl) => {
    const raw = await loadRows(csvUrl);
    const rows = normalize(raw, "踩点データ");
    return {
      raw: raw.length, parsed: rows.length,
      outOfJapan: rows.filter(r => !(r.lat >= 24 && r.lat <= 46 && r.lng >= 122 && r.lng <= 146)).length,
      coordSample: rows.slice(0, 3).map(r => [r.lat, r.lng]),
      noName: rows.filter(r => r.name === "(名称なし)").length,
      nameSample: rows.slice(0, 3).map(r => r.name),
      cats: [...new Set(rows.map(r => r.cat))].length,
      skippedNoCoord: raw.length - rows.length,
    };
  }, CSV_URL);

  console.log("  raw:", audit.raw, "/ parsed:", audit.parsed, "/ 无坐标跳过:", audit.skippedNoCoord);
  // 无坐标/无店名行是数据本身的空值（如 RecordID=后补1/2 的两条），允许少量存在
  check("无坐标跳过 ≤ 50（坐标列正常解析）", audit.skippedNoCoord <= 50, audit.skippedNoCoord);
  check("坐标全部在日本范围（合并列拆分 OK）", audit.outOfJapan === 0, audit.outOfJapan);
  check("坐标样例 lng 应为 ~135（大阪）", audit.coordSample.every(([la, ln]) => ln > 130), audit.coordSample);
  check("店名缺失 ≤ 20（ShopName 识别 OK）", audit.noName <= 20, audit.noName);
  check("店名样例为日文原名", audit.nameSample.some(n => /[ぁ-んァ-ヶ一-龠々]/.test(n)), audit.nameSample);
  check("Industry 当分类生效（>1 类）", audit.cats > 1, audit.cats);
  check("无 JS 报错", errors.length === 0, errors);

  await page.screenshot({ path: "smoke_spot_live.png" });
  console.log("\n=== 汇总 ===");
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
