/**
 * 用真实浅草数据（asakusa.csv, 1598 行）压一遍处理层
 * 做法：把真实数据当「踩点源」，再从中抽出一部分、故意把写法改乱当「Knot 源」，
 *       看处理层还能不能把它们认出来 —— 认得出才说明匹配规则是真的有效。
 * 用法：node gas/test_real.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

/* ---- 假 Apps Script 环境（只放处理层实际会用到的） ---- */
const props = { SHEET_ID: "S", SPOT_SHEET_ID: "SPOT", GEO_RADIUS: "50", GEOCODE_ENABLED: "0" };
const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt,
  encodeURIComponent, decodeURIComponent, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getSheets: () => [] }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 404, getContentText: () => "{}" }) },
  Utilities: { newBlob: () => ({ getBytes: () => Buffer.from("") }), base64Encode: () => "" },
  ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } }) }), XFrameOptionsMode: {} },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }), deleteTrigger() {}, WeekDay: {} }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8"), sandbox, { filename: "Code.gs" });
vm.runInContext(fs.readFileSync(path.join(__dirname, "Pipeline.gs"), "utf8"), sandbox, { filename: "Pipeline.gs" });

/* ---- 读真实数据 ---- */
const csv = fs.readFileSync(path.join(__dirname, "..", "asakusa.csv"), "utf8");
const spot = sandbox.parseCsvText(csv).map(sandbox.toStd);
console.log("踩点源（真实 asakusa.csv）:", spot.length, "行");

/* ---- 造 Knot 源：取其中 400 家，故意把写法改乱 ---- */
function mangle(r, i) {
  // 四种真实世界里最常见的写法差异，轮换施加
  const mode = i % 4;
  let name = r.name, addr = r.address;
  if (mode === 0) name = "株式会社" + name;                       // 加法人前缀
  if (mode === 1) addr = addr.replace(/^東京都台東区/, "東京都台東区");  // 不变（对照组）
  if (mode === 2) { addr = addr.replace(/(\d+)-(\d+)-(\d+)/, "$1丁目$2番$3号"); name = name.replace(/\s/g, ""); }
  if (mode === 3) name = name.replace(/[（(].*?[）)]/g, "").trim(); // 去括号备注
  return {
    merchant_id: "", name: name, address: addr,
    category: "已铺设礼包或汇率", institution: "OS", material: "汇率物料",
    lat: r.lat, lng: r.lng, week: "2026-W39", note: ""
  };
}
const knot = spot.slice(0, 400).map((r, i) => sandbox.toStd(mangle(r, i)));
console.log("Knot 源（同一批店但写法改乱）:", knot.length, "行");

/* ---- 跑匹配 ---- */
const t0 = Date.now();
const m = sandbox.matchAndMerge(spot, knot);
const ms = Date.now() - t0;
const s = m.stats;
console.log("\n突合结果:", JSON.stringify(s));
console.log("耗时:", ms, "ms");
console.log("理论上限 both = 400 / 实际 both =", s.both, " 召回率 =", (s.both / 400 * 100).toFixed(1) + "%");

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log("  [OK] " + l); } else { fail++; console.log("  [FAIL] " + l + (e !== undefined ? "  -> " + JSON.stringify(e) : "")); } };

check("召回率 ≥ 95%（写法改乱也认得出）", s.both / 400 >= 0.95, s.both);
check("没有把不相关的店错配（both 不超 400）", s.both <= 400, s.both);
check("总数 = 1598（不是 1598+400 的叠加）", m.rows.length === 1598, m.rows.length);
check("6000 点规模下耗时 < 20s", ms < 20000, ms);

const bad = m.rows.filter(r => r.match_status === "knot-only");
console.log("  未命中的例子（前 3）:", bad.slice(0, 3).map(r => r.name + " / " + r.address));

console.log("\n=== 汇总 ===");
console.log("  PASS:", pass, "  FAIL:", fail);
process.exit(fail ? 1 : 0);
