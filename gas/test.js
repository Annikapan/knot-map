/**
 * Code.gs 的本地自检脚本（不需要部署到 GAS 就能跑）
 * 用法：node gas/test.js
 * 它用假的 Apps Script 环境把后端逻辑真跑一遍：doPost / normalize / appendRows / readAll / getPoints / doGet
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

// Code.gs = 入口/存档，Pipeline.gs = 突合・処理層。両方まとめて同じコンテキストに入れる（GAS と同じ）
const SRC = [path.join(__dirname, "Code.gs"), path.join(__dirname, "Pipeline.gs")];

function makeSheet() {
  return {
    rows: [],
    getLastRow() { return this.rows.length; },
    getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); },
    clear() { this.rows = []; return this; },
    appendRow(a) { this.rows.push(a.slice()); },
    getRange(r, c, nr, nc) {
      const self = this;
      return {
        setValues(v) {
          for (let i = 0; i < v.length; i++) {
            const idx = r - 1 + i;
            while (self.rows.length <= idx) self.rows.push([]);
            self.rows[idx] = v[i].slice();
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = self.rows[r - 1 + i] || [];
            const rr = [];
            for (let j = 0; j < nc; j++) rr.push(row[c - 1 + j] === undefined ? "" : row[c - 1 + j]);
            out.push(rr);
          }
          return out;
        }
      };
    }
  };
}

const SHEETS = {};
const props = {
  SHEET_ID: "TEST_SHEET", WEBHOOK_TOKEN: "tok123", MAPS_API_KEY: "",
  GITHUB_OWNER: "", GITHUB_REPO: "", GITHUB_TOKEN: ""
};
const fetchLog = [];

const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  SpreadsheetApp: {
    openById(id) {
      if (!SHEETS[id]) SHEETS[id] = {};
      return {
        getSheetByName: n => SHEETS[id][n] || null,
        insertSheet(n) { const s = makeSheet(); SHEETS[id][n] = s; return s; },
        getSheets() { return Object.keys(SHEETS[id]).map(k => SHEETS[id][k]); }
      };
    }
  },
  ContentService: {
    createTextOutput: t => ({ text: t, setMimeType() { return this; } }),
    MimeType: { JSON: "application/json" }
  },
  HtmlService: {
    createTemplateFromFile: () => ({
      evaluate() {
        return {
          setTitle() { return this; },
          setXFrameOptionsMode() { return this; },
          addMetaTag() { return this; }
        };
      }
    }),
    XFrameOptionsMode: { ALLOWALL: "ALLOWALL" }
  },
  UrlFetchApp: {
    fetch(url, opt) {
      fetchLog.push({ url, method: (opt && opt.method) || "get" });
      return { getResponseCode: () => 404, getContentText: () => "{}" };
    }
  },
  Utilities: {
    newBlob: t => ({ getBytes: () => Buffer.from(String(t), "utf8") }),
    base64Encode: b => Buffer.from(b).toString("base64")
  },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }),
    deleteTrigger() {},
    WeekDay: { MONDAY: "MONDAY" }
  }
};

vm.createContext(sandbox);
SRC.forEach(f => vm.runInContext(fs.readFileSync(f, "utf8"), sandbox, { filename: path.basename(f) }));

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  [OK] " + label); }
  else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function post(payload, token) {
  const e = { parameter: { token }, headers: {}, postData: { contents: JSON.stringify(payload) } };
  return JSON.parse(sandbox.doPost(e).text);
}

console.log("\n=== 1. W39 首次推送（3 行，其中 1 行缺坐标）===");
const w39 = [
  { week: "2026-W39", merchant_id: "M001", name: "浅草 店A", category: "已铺KIOSK", institution: "OS", material: "汇率物料", address: "東京都台東区浅草1-1-1", lat: 35.7148, lng: 139.7967 },
  { week: "2026-W39", merchant_id: "M002", name: "浅草 店B", category: "已查商户", institution: "Tierra", material: "礼包物料", address: "東京都台東区浅草2-2-2", latitude: 35.7155, longitude: 139.7980 },
  { week: "2026-W39", merchant_id: "M003", name: "缺坐标店", category: "已查商户", address: "東京都台東区浅草3-3-3" }
];
const r1 = post(w39, "tok123");
console.log("  resp:", JSON.stringify(r1));
check("鉴权 + 解析成功 ok:true", r1.ok === true, r1);
// ※ 2026-09-23 変更：無座標行は「捨てない」。空欄で残し Pipeline の住所ジオコーディングで補う。
check("缺坐标行也被保留（received=3）", r1.received === 3, r1.received);
const sheetNow = SHEETS["TEST_SHEET"]["明细"];
const rowB = sheetNow.rows.find(r => r[1] === "M002") || [];
check("latitude/longitude 别名被识别（M002 有坐标）",
      parseFloat(rowB[7]) === 35.7155 && parseFloat(rowB[8]) === 139.7980, [rowB[7], rowB[8]]);
const rowC = sheetNow.rows.find(r => r[1] === "M003") || [];
check("缺坐标行 lat/lng 落库为空串（等补全，不是 0、不是 NaN）",
      rowC[7] === "" && rowC[8] === "", [rowC[7], rowC[8]]);

console.log("\n=== 2. W40 二次推送（M001 重复，分类更新）===");
const w40 = [
  { week: "2026-W40", merchant_id: "M001", name: "浅草 店A", category: "已铺WXP logo", institution: "OS", material: "汇率物料", address: "東京都台東区浅草1-1-1", lat: 35.7148, lng: 139.7967 },
  { week: "2026-W40", merchant_id: "M004", name: "浅草 店D", category: "药妆", institution: "LIAN", material: "礼包物料", address: "東京都台東区浅草4-4-4", lat: 35.7160, lng: 139.7990 }
];
const r2 = post(w40, "tok123");
console.log("  resp:", JSON.stringify(r2));
const sheet = SHEETS["TEST_SHEET"]["明细"];
console.log("  Sheet 实际行数（含表头）:", sheet.rows.length);
check("Sheet 只增不覆盖（1表头 + 3 + 2 = 6 行）", sheet.rows.length === 6, sheet.rows.length);
check("去重后 total=4（M001/M002/M003/M004）", r2.total === 4, r2.total);

console.log("\n=== 3. getPoints() 契约（地图页用）===");
const gp = sandbox.getPoints();
console.log("  rows:", gp.rows.length, " skipped:", gp.skipped);
check("返回 rows 数组", Array.isArray(gp.rows) && gp.rows.length === 3);
// ※ 踩点源未設定でも buildMerged が「合并」を作るので、行は突合後の 21 項目になる
check("每行是突合后的 21 字段（含 match_status）",
  Object.keys(gp.rows[0]).length === 21 && gp.rows[0].match_status === "knot-only",
  Object.keys(gp.rows[0]));
const m001 = gp.rows.find(x => x.merchant_id === "M001");
check("M001 取最新周 W40 / 已铺WXP logo", m001 && m001.week === "2026-W40" && m001.category === "已铺WXP logo", m001);

console.log("\n=== 4. doGet(?format=json) 供静态页读取 ===");
const dgj = JSON.parse(sandbox.doGet({ parameter: { format: "json" } }).text);
check("JSON 模式返回 rows", dgj.ok === true && dgj.rows.length === 3, dgj.total);

console.log("\n=== 5. doGet() 默认返回 HtmlService 页面 ===");
const page = sandbox.doGet({ parameter: {} });
check("默认分支走 HtmlService（返回页面对象）", page && typeof page.setTitle === "function");

console.log("\n=== 6. 错误分支 ===");
check("token 错误 -> unauthorized", post(w39, "wrong").error === "unauthorized");
const bad = JSON.parse(sandbox.doPost({ parameter: { token: "tok123" }, headers: {}, postData: { contents: "not-json" } }).text);
check("非法 JSON -> invalid json", bad.error === "invalid json");
check("空数组 -> no rows", post([], "tok123").error === "no rows");

console.log("\n=== 7. isoWeek() ===");
check("2026-09-22 落在 2026-W39", sandbox.isoWeek(new Date("2026-09-22T00:00:00Z")) === "2026-W39", sandbox.isoWeek(new Date("2026-09-22T00:00:00Z")));

console.log("\n=== 汇总 ===");
console.log("  PASS:", pass, "  FAIL:", fail);
console.log("  UrlFetchApp 调用（GitHub 更新，未配置故为占位）:", JSON.stringify(fetchLog));
process.exit(fail ? 1 : 0);
