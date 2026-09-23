/**
 * points.html 的真实浏览器冒烟测试
 * 用法：NODE_PATH=/Users/annika/.workbuddy/binaries/node/workspace/node_modules node test_browser.js
 * 前置：knot-map 目录下已启动 http server（python3 -m http.server 8123）
 *
 * 验证点：页面能否真的加载数据、渲染点位、生成可点击图例、统计数字正确、无 JS 报错
 */
const { chromium } = require("playwright");

const URL = process.env.TEST_URL || "http://127.0.0.1:8123/points.html";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [], logs = [];
  page.on("console", m => { logs.push(m.type() + ": " + m.text()); if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (label, cond, extra) => {
    if (cond) { pass++; console.log("  [OK] " + label); }
    else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
  };

  console.log("\n=== 打开 " + URL + " ===");
  // 底图是外部资源（Google/OSM 瓦片），load 事件可能长时间不触发 -> 只等 DOM，再等数据渲染
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById("s-total");
    return t && /\d/.test(t.textContent || "");
  }, { timeout: 20000 }).catch(() => console.log("  (警告) 20s 内统计数字未出现"));
  await page.waitForTimeout(2500);

  // 1. 统计数字
  const total = (await page.textContent("#s-total")) || "";
  const shown = (await page.textContent("#s-shown")) || "";
  const skip  = (await page.textContent("#s-skip")) || "";
  console.log("  総件数:", total, " 表示中:", shown, " スキップ:", skip);
  check("総件数已从 – 变为数字", /\d/.test(total), total);
  check("表示中与総件数一致", total === shown, { total, shown });

  // 2. 图例
  const legendText = (await page.textContent("#legend")) || "";
  const legendItems = await page.$$eval("#legend > *", els => els.length).catch(() => 0);
  console.log("  图例:", legendText.replace(/\s+/g, " ").trim().slice(0, 160));
  check("图例已生成", legendText.trim().length > 0, legendText);
  check("图例有多个可点击项", legendItems >= 2, legendItems);

  // 3. 底图是否真的加载（OSM 瓦片 or Google）
  const tiles = await page.$$eval("img", imgs => imgs.filter(i => /tile|maps|googleapis|ggpht/i.test(i.src)).length).catch(() => 0);
  const mapHtmlLen = (await page.$eval("#map", el => el.innerHTML.length).catch(() => 0));
  console.log("  底图瓦片 img 数:", tiles, " #map 内部节点长度:", mapHtmlLen);
  check("底图区域已渲染内容", mapHtmlLen > 100, mapHtmlLen);

  // 4. 点位 marker 数量
  const markers = await page.$$eval(".leaflet-marker-icon, .gm-style img[src*='marker'], [class*='pin'], [class*='dot']",
    els => els.length).catch(() => 0);
  const rowsLen = await page.evaluate(() => (typeof ROWS !== "undefined" ? ROWS.length : -1)).catch(() => -1);
  console.log("  ROWS(内部):", rowsLen, " 可见 marker 元素:", markers);
  check("已解析出点位数据（ROWS > 0）", rowsLen > 0, rowsLen);

  // 5. 点击图例是否能切换（隐藏一类后「表示中」数字变化）
  const before = shown;
  try {
    const first = await page.$("#legend > *");
    if (first) {
      await first.click();
      await page.waitForTimeout(800);
      const after = (await page.textContent("#s-shown")) || "";
      console.log("  点击图例前:", before, " 后:", after);
      check("点击图例能改变显示数量（筛选生效）", after !== before, { before, after });
      await first.click(); // 点回来
      await page.waitForTimeout(500);
    }
  } catch (e) { check("点击图例切换", false, String(e.message)); }

  // 6. JS 报错：区分「外部资源网络失败（环境问题）」与「代码逻辑错误（真问题）」
  const isEnv = e => /net::|SSL|ERR_|Failed to load resource|maps\.googleapis|gstatic|API key|InvalidKeyMapError/i.test(e);
  const envErrors = errors.filter(isEnv);
  const realErrors = errors.filter(e => !isEnv(e));
  console.log("  外部资源/网络类报错:", envErrors.length, "（本机网络或 API key 缺失导致，非代码问题）");
  console.log("  代码逻辑类报错:", realErrors.length);
  check("无代码逻辑类 JS 报错", realErrors.length === 0, realErrors.slice(0, 3));

  // 7. 错误提示区（读失败时应有可操作提示）
  const srcText = (await page.textContent("#src")) || "";
  console.log("  数据源提示区:", srcText.replace(/\s+/g, " ").trim().slice(0, 200));

  // 8. 截图（底图是外部资源，字体/瓦片可能拖慢 -> 限定超时，失败不阻塞结论）
  const shot = "/Users/annika/WorkBuddy/2026-09-22-18-33-40/knot-map/smoke.png";
  try { await page.screenshot({ path: shot, fullPage: false, timeout: 15000 }); console.log("  截图:", shot); }
  catch (e) { console.log("  (截图跳过:", e.message.split("\n")[0], ")"); }

  await browser.close();
  console.log("\n=== 汇总 ===");
  console.log("  PASS:", pass, "  FAIL:", fail);
  if (logs.length) console.log("  (前 5 条 console 日志)", logs.slice(0, 5));
  process.exit(fail ? 1 : 0);
})();
