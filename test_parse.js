/**
 * points.html 的 CSV/JSON 解析自检脚本（不需要浏览器）
 * 用法：node test_parse.js
 * 重点验证：Google Sheets「ウェブに公開→CSV」的真实输出格式能否被正确解析
 *   - UTF-8 BOM、CRLF 换行、引号包裹含逗号/换行的字段、末尾空行、全角列名
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "points.html"), "utf8");
const m = html.match(/<script>\s*(\n[\s\S]*?)\n<\/script>/);
if (!m) { console.error("找不到内联脚本"); process.exit(1); }
const code = m[1];

// ---- 假的 DOM 环境 ----
function el() {
  return {
    textContent: "", innerHTML: "", value: "", disabled: false, checked: true,
    onclick: null, onchange: null, oninput: null, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, querySelectorAll: () => []
  };
}
const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, isNaN, parseFloat, parseInt,
  URLSearchParams, Promise, Set, Map, RegExp, Error,
  location: { search: "" },
  document: {
    getElementById: el, querySelectorAll: () => [], querySelector: el,
    createElement: () => ({ rel: "", onload: null, onerror: null }),
    head: { appendChild() {} }, body: { appendChild() {} }
  },
  window: {},
  fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/csv" }, text: async () => sandbox.__CSV })
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code + "\n;globalThis.__api={parseCSV,mapCols,normalize,loadRows,ALIAS,getSkipped:()=>skippedCount};", sandbox, { filename: "points.html" });
const api = sandbox.__api;

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  [OK] " + label); }
  else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

/* ---------- 1. Google Sheets 发布格式（BOM + CRLF + 引号） ---------- */
console.log("\n=== 1. Google Sheets「ウェブに公開→CSV」真实格式 ===");
const sheetsCsv =
  "\uFEFF" +
  "week,merchant_id,名称,分类,institution,material,住所,lat,lng,note\r\n" +
  "2026-W39,M001,浅草 店A,已铺KIOSK,OS,汇率物料,\"東京都台東区浅草1-1-1, 仲見世通り\",35.7148,139.7967\r\n" +
  "2026-W39,M002,浅草 店B,已查商户,Tierra,礼包物料,\"東京都台東区浅草2-2-2\n2F\",35.7155,139.7980\r\n" +
  "2026-W40,M003,浅草 店C,药妆,LIAN,礼包物料,東京都台東区浅草3-3-3,35.7160,139.7990,\"備考,カンマあり\"\r\n" +
  "\r\n";
const g1 = api.parseCSV(sheetsCsv);
console.log("  解析出数据行:", g1.length - 1, " 首行表头:", JSON.stringify(g1[0]));
check("去掉 BOM（首列名不被污染）", g1[0][0] === "week", g1[0][0]);
check("CRLF 正常断行（4 行：表头 + 3 数据）", g1.length === 4, g1.length);
check("引号内含逗号的地址未被切碎", g1[1][6] === "東京都台東区浅草1-1-1, 仲見世通り", g1[1][6]);
check("引号内含换行也能保留", g1[2][6].includes("\n"), g1[2][6]);
check("末尾空行被过滤", g1.length === 4);

/* ---------- 2. 列名映射 ---------- */
console.log("\n=== 2. 列名自动映射（中日英混用）===");
for (const [label, headers, expectKey, expectIdx] of [
  ["标准英文表头", ["week","merchant_id","name","category","address","lat","lng"], "lat", 5],
  ["Code.gs 的 10 列中文表头", ["week","merchant_id","name","category","institution","material","address","lat","lng","note"], "category", 3],
  ["日文表头", ["週次","名称","カテゴリ","住所","緯度","経度"], "lat", 4],
  ["全大写/带空格", ["Name"," Category ","LATITUDE","LONGITUDE"], "lng", 3],
]) {
  const c = api.mapCols(headers);
  check(label, c[expectKey] === expectIdx, c);
}

/* ---------- 3. 走完整 loadRows -> normalize ---------- */
console.log("\n=== 3. loadRows + normalize 端到端（模拟 fetch 返回上面的 CSV）===");
(async () => {
  sandbox.__CSV = sheetsCsv;
  sandbox.__api.setCsv = null;
  // loadRows 内部用 fetch -> 已 stub 返回 __CSV
  const raw = await api.loadRows();
  console.log("  loadRows 返回对象数:", raw.length);
  check("loadRows 返回 3 条", raw.length === 3, raw.length);

  // 重新 stub：loadRows 已消费；直接用 raw 喂 normalize
  const rows = api.normalize(raw);
  console.log("  点数:", rows.length, " 分类:", [...new Set(rows.map(r => r.cat))].join(" / "));
  check("normalize 产出 3 个点", rows.length === 3, rows.length);
  check("坐标正确", rows[0].lat === 35.7148 && rows[0].lng === 139.7967, rows[0]);
  check("分类正确", rows[0].cat === "已铺KIOSK", rows[0].cat);
  check("周次正确", rows[0].week === "2026-W39", rows[0].week);
  check("扩展字段保留（institution/material/merchant_id）",
    rows[0].extras && rows[0].extras.institution === "OS" && rows[0].extras.material === "汇率物料",
    rows[0].extras);
  check("地址带逗号也完整保留", rows[0].address === "東京都台東区浅浅".slice(0,0) + rows[0].address && rows[0].address.includes("仲見世通り"), rows[0].address);

  /* ---------- 4. 缺坐标 / 脏数据 ---------- */
  console.log("\n=== 4. 脏数据容错 ===");
  const dirty = [{ name:"空坐标", address:"x", lat:"", lng:"" },
                 { name:"0,0", address:"x", lat:"0", lng:"0" },
                 { name:"文字", address:"x", lat:"abc", lng:"-" },
                 { name:"正常", address:"x", lat:"35.1", lng:"139.1" }];
  const d = api.normalize(dirty);
  check("4 条脏数据只留 1 个点", d.length === 1, d.length);
  check("skippedCount 记为 3", api.getSkipped() === 3, api.getSkipped());

  /* ---------- 5. 缺经纬度列 -> 明确报错 ---------- */
  console.log("\n=== 5. 表头缺经纬度列 ===");
  let threw = "";
  try { api.normalize([{ 名称:"a", 住所:"b" }]); } catch (e) { threw = String(e.message); }
  check("抛出可读错误（提示缺纬度/经度列）", threw.includes("緯度/経度"), threw);

  console.log("\n=== 汇总 ===");
  console.log("  PASS:", pass, "  FAIL:", fail);
  process.exit(fail ? 1 : 0);
})();
