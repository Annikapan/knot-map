/**
 * 用真实 asakusa.csv 造一份「突合済み」样例，用来验证处理层 + 地图页
 * 用法: node gas/make_sample.js
 * 输出: ../merged_sample.csv（GAS「合并」Sheet 的列结构一模一样）
 *
 * 场景假设：踩点表里 1598 家，其中 500 家已经在 Knot 侧铺了物料。
 * 期望产出：both=500（铺过+踩过）/ spot-only=1098（踩过但没铺）→ 地图上两种颜色。
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const props = {
  SHEET_ID: "S", GEO_RADIUS: "50", GEOCODE_ENABLED: "0",
  INCENTIVE_AREAS: "東京都,大阪府,北海道",
  AREA_RULES: JSON.stringify({ "浅草": ["浅草", "Asakusa"], "合羽橋": ["合羽橋"], "雷門": ["雷門", "雷门"] })
};
const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt, encodeURIComponent, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => null, insertSheet: () => null, getSheets: () => [] }) },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 404, getContentText: () => "{}" }) },
  Utilities: { newBlob: () => ({ getBytes: () => Buffer.from("") }), base64Encode: () => "" },
  ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: {} },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } }) }) },
  XFrameOptionsMode: {},
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }), deleteTrigger() {}, WeekDay: {} }
};
vm.createContext(sandbox);
["Code.gs", "Pipeline.gs"].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f }));

// ※ isLL / MERGED_COLS は Pipeline.gs 内で const 宣言のため vm 外からは見えないので、ここで同じ定義を持つ
const isLL = r => r && isFinite(parseFloat(r.lat)) && isFinite(parseFloat(r.lng)) &&
                  !(parseFloat(r.lat) === 0 && parseFloat(r.lng) === 0);
const COLS = ["merchant_id", "name", "category", "spot_category", "knot_category",
  "institution", "material", "address", "lat", "lng", "week",
  "in_spot", "in_knot", "match_status", "match_level", "match_score",
  "prefecture", "incentive", "area", "geocoded", "note"];

const spot = sandbox.parseCsvText(fs.readFileSync(path.join(__dirname, "..", "asakusa.csv"), "utf8")).map(sandbox.toStd);
const knot = spot.filter((r, i) => i % 3 === 0).slice(0, 500).map((r, i) => sandbox.toStd({
  merchant_id: "", name: r.name, address: r.address, lat: r.lat, lng: r.lng,
  category: ["已铺设礼包或汇率", "已接入子商户", "已铺设PP logo或菊花码"][i % 3],
  institution: ["OS", "Tierra", "IMPREX", "LIAN", "Spring rea"][i % 5],
  material: i % 2 ? "汇率物料" : "礼包物料", week: "2026-W39"
}));

const m = sandbox.matchAndMerge(spot, knot);
sandbox.tagArea(m.rows);
const rows = m.rows.filter(isLL);

// CSV のエスケープは「" を "" に重ねる」方式（JSON.stringify の \" だと一般の CSV 読込で壊れる）
const esc = s => {
  s = String(s === undefined || s === null ? "" : s);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const lines = [COLS.join(",")].concat(rows.map(r => COLS.map(c => esc(r[c])).join(",")));
fs.writeFileSync(path.join(__dirname, "..", "merged_sample.csv"), lines.join("\n"), "utf8");

const tally = k => { const o = {}; rows.forEach(r => { if (r[k]) o[r[k]] = (o[r[k]] || 0) + 1; }); return o; };
console.log("突合:", JSON.stringify(m.stats));
console.log("可上图:", rows.length, "行 → merged_sample.csv");
console.log("match_status:", JSON.stringify(tally("match_status")));
console.log("商圈:", JSON.stringify(tally("area")));
console.log("服务商:", JSON.stringify(tally("institution")));
