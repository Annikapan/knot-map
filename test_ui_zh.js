/**
 * 中文界面 + My Maps 风格侧栏 的浏览器测试
 * 用法：NODE_PATH=/Users/annika/.workbuddy/binaries/node/workspace/node_modules node test_ui_zh.js
 * 前置：knot-map 目录下已启动 http server（127.0.0.1:8123）
 *
 * 验证点：① 侧栏不再出现日文假名 ② 关键中文标签齐全 ③ 搜索框能过滤并定位 ④ 无 JS 报错
 */
const { chromium } = require("playwright");

const SPOT_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTflfloJoLCv0H--qT8tsu4AfvpbAmQyE9wEbCso7dWTj3rYrwHzbzehU8ZKoXzyfK9FuMh_qSrIB7P/pub?gid=0&single=true&output=csv";
const URL = process.env.TEST_URL ||
  "http://127.0.0.1:8123/points.html?sources=" + encodeURIComponent(JSON.stringify([
    { label: "踩点数据（Sheets）", url: SPOT_CSV }
  ]));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (label, cond, extra) => {
    if (cond) { pass++; console.log("  [OK]   " + label); }
    else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
  };

  console.log("\n=== 打开 " + URL.slice(0, 80) + "… ===");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById("s-total");
    return t && /\d/.test(t.textContent || "");
  }, { timeout: 25000 }).catch(() => console.log("  (警告) 25s 内统计数字未出现"));
  await page.waitForTimeout(2500);

  // 1. 界面语言
  //    ※ 只检查「界面框架文字」：图层名/店名来自数据本身（日文业态・日文店名），
  //      必须保留原名才能跟踩点表匹配，不能算作未中文化
  const uiText = await page.evaluate(() => {
    const panel = document.getElementById("panel").cloneNode(true);
    ["legend", "hitList", "srcList", "src"].forEach(id => {
      const el = panel.querySelector("#" + id); if (el) el.remove();
    });
    return panel.textContent || "";
  });
  const kana = (uiText.match(/[ぁ-んァ-ヶ]/g) || []);
  check("界面框架文字无日文假名（已中文化）", kana.length === 0, kana.slice(0, 20).join(""));
  check("html lang=zh-CN", (await page.getAttribute("html", "lang")) === "zh-CN");

  const panelText = (await page.textContent("#panel")) || "";
  for (const w of ["图层", "底图", "周次", "地点总数", "当前显示"]) {
    check("含中文标签「" + w + "」", panelText.includes(w));
  }
  console.log("  侧栏前 160 字:", panelText.replace(/\s+/g, " ").trim().slice(0, 160));

  // 2. My Maps 风格：图层行带图钉图标 + 计数
  const pins = await page.$$eval("#legend .lg svg.pin", els => els.length).catch(() => 0);
  const layers = await page.$$eval("#legend .lg", els => els.length).catch(() => 0);
  check("图层行有图钉图标", pins > 0 && pins === layers, { pins, layers });

  // 3. 搜索框
  const before = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  await page.fill("#q", "ラーメン");
  await page.waitForTimeout(1200);
  const after = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  const hits = await page.$$eval("#hitList .hit", els => els.length).catch(() => 0);
  console.log("  搜索「ラーメン」前:", before, " 后:", after, " 结果条目:", hits);
  check("搜索后显示数变少（过滤生效）", after < before && after > 0, { before, after });
  check("搜索结果列表已生成", hits > 0, hits);

  // 4. 点击搜索结果能定位（不报错 + 地图中心变化）
  const errBefore = errors.length;
  await page.click("#hitList .hit");
  await page.waitForTimeout(1200);
  // lmap/gmap 是脚本顶层的 let 绑定（不属于 window），只能按名字直接引用
  const zoom = await page.evaluate(() => {
    try { if (typeof lmap !== "undefined" && lmap) return lmap.getZoom(); } catch (e) {}
    try { if (typeof gmap !== "undefined" && gmap) return gmap.getZoom(); } catch (e) {}
    return -1;
  });
  console.log("  点击结果后 zoom:", zoom);
  check("点击搜索结果后地图缩放到点位（zoom ≥ 15）", zoom >= 15, zoom);
  check("点击搜索结果未产生新报错", errors.length === errBefore, errors.slice(errBefore));

  // 5. 清空搜索能恢复
  await page.fill("#q", "");
  await page.waitForTimeout(1200);
  const restored = parseInt(((await page.textContent("#s-shown")) || "0").replace(/[^\d]/g, ""), 10);
  check("清空搜索后恢复全部", restored === before, { before, restored });

  // 6. 无代码逻辑类报错
  const realErr = errors.filter(e => !/favicon|net::ERR_|Failed to load resource|InvalidKeyMapError|googleapis|gstatic/i.test(e));
  check("无代码逻辑类 JS 报错", realErr.length === 0, realErr.slice(0, 3));

  await page.fill("#q", "ラーメン");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "smoke_ui_zh.png", fullPage: false });
  console.log("  截图: smoke_ui_zh.png");

  await browser.close();
  console.log("\n=== 汇总 ===\n  PASS:", pass, "  FAIL:", fail);
  process.exit(fail ? 1 : 0);
})();
