/**
 * Knot 主动拉取（pullFromKnot）自检 —— 不用部署 GAS 就能跑
 * 用法：node gas/test_knot.js
 *
 * 覆盖：未配置跳过 / 纯JSON / SSE流 / markdown围栏 / 无坐标保留 / HTTP错误 / 垃圾文本 / token头
 */
const fs = require("fs"), vm = require("vm"), path = require("path");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  [OK] " + label); }
  else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

/* ---------- GAS 环境 mock（同 test.js 思路） ---------- */
const props = { SHEET_ID: "S", WEBHOOK_TOKEN: "tok123" };
const SHEETS = {};
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
        setValues(v) { for (let i = 0; i < v.length; i++) { const idx = r - 1 + i; while (self.rows.length <= idx) self.rows.push([]); self.rows[idx] = v[i].slice(); } },
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = self.rows[r - 1 + i] || []; const rr = []; for (let j = 0; j < nc; j++) rr.push(row[c - 1 + j] === undefined ? "" : row[c - 1 + j]); out.push(rr); } return out; }
      };
    }
  };
}

let lastFetch = null;   // 记录最后一次 UrlFetchApp 调用，验证 header

const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt,
  encodeURIComponent, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  SpreadsheetApp: { openById(id) {
    if (!SHEETS[id]) SHEETS[id] = {};
    const b = SHEETS[id];
    return { getSheetByName: n => b[n] || null, insertSheet(n) { const s = makeSheet(); b[n] = s; return s; }, getSheets: () => Object.keys(b).map(k => b[k]) };
  } },
  UrlFetchApp: { fetch(url, opt) {
    lastFetch = { url, opt };
    const r = FAKE_RESP.shift() || { code: 200, text: "{}" };
    return { getResponseCode: () => r.code, getContentText: () => r.text };
  } },
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

let FAKE_RESP = [];

/* ---------- 1. 未配置 → 跳过 ---------- */
console.log("\n=== 1. 未配置 KNOT_AGENT_URL / TOKEN ===");
let r = sandbox.pullFromKnot();
check("skipped=true，不影响推送链路", r.ok === false && r.skipped === true, r);

/* ---------- 2. 纯 JSON ---------- */
console.log("\n=== 2. agent 直接返回纯 JSON ===");
props.KNOT_AGENT_URL = "https://knot.woa.com/apigw/api/v1/agents/agui/TEST";
props.KNOT_AGENT_TOKEN = "knot_xxx";
FAKE_RESP = [{ code: 200, text: JSON.stringify({
  ok: true, week: "2026-W39",
  rows: [
    { week: "2026-W39", merchant_id: "K1", name: "浅草 店A", category: "已接入子商户", institution: "OS", material: "", address: "東京都台東区浅草1-1-1", lat: 35.7148, lng: 139.7967 },
    { week: "2026-W39", merchant_id: "K2", name: "浅草 店B", category: "已铺设礼包或汇率", institution: "Tierra", material: "礼包物料", address: "東京都台東区浅草2-2-2", lat: "", lng: "" }
  ]
}) }];
r = sandbox.pullFromKnot({ week: "2026-W39" });
check("ok:true", r.ok === true, r);
check("received = 2", r.received === 2, r);
check("写入 Sheet 2 行", r.added === 2, r);
check("无坐标那行也入库（lat 空串）", (() => {
  const sh = SHEETS["S"]["明细"];
  const row = sh.rows.find(x => x[1] === "K2") || [];
  return row[7] === "" && row[8] === "";
})(), SHEETS["S"]["明细"].rows);

/* ---------- 3. SSE 流 ---------- */
console.log("\n=== 3. agent 返回 SSE 流（data: {...}）===");
const sse = [
  'data: {"type":"RUN_STARTED","rawEvent":{"conversation_id":"c1"}}',
  '',
  'data: {"type":"TEXT_MESSAGE_CONTENT","rawEvent":{"content":"{\\"ok\\":true,\\"week\\":\\"2026-W40\\",\\"rows\\":["}}',
  'data: {"type":"TEXT_MESSAGE_CONTENT","rawEvent":{"content":"{\\"merchant_id\\":\\"K3\\",\\"name\\":\\"浅草 店C\\",\\"address\\":\\"東京都台東区浅草3-3-3\\",\\"lat\\":35.71,\\"lng\\":139.79}]}"}}',
  'data: [DONE]'
].join("\n");
FAKE_RESP = [{ code: 200, text: sse }];
r = sandbox.pullFromKnot({ week: "2026-W40" });
check("SSE 拼接后解析成功", r.ok === true && r.received === 1, r);

/* ---------- 4. markdown 代码围栏 ---------- */
console.log("\n=== 4. agent 返回带 ```json 围栏的文本 ===");
FAKE_RESP = [{ code: 200, text: '```json\n{"ok":true,"rows":[{"merchant_id":"K4","name":"浅草 店D","address":"東京都台東区浅草4-4-4","lat":35.72,"lng":139.80}]}\n```' }];
r = sandbox.pullFromKnot({ week: "2026-W41" });
check("围栏被剥掉，解析成功", r.ok === true && r.received === 1, r);

/* ---------- 5. HTTP 错误 ---------- */
console.log("\n=== 5. HTTP 500 ===");
FAKE_RESP = [{ code: 500, text: "Internal Server Error" }];
r = sandbox.pullFromKnot();
check("ok:false 且带 http 状态码", r.ok === false && r.http === 500, r);

/* ---------- 6. 垃圾文本 ---------- */
console.log("\n=== 6. 返回非 JSON（模型开始闲聊）===");
FAKE_RESP = [{ code: 200, text: "本周数据我已经帮你查好了，请问还需要什么帮助？" }];
r = sandbox.pullFromKnot();
check("ok:false 并给出可诊断提示", r.ok === false && /解析不出 JSON/.test(r.error || ""), r);

/* ---------- 7. token 头 ---------- */
console.log("\n=== 7. 认证头 ===");
FAKE_RESP = [{ code: 200, text: '{"rows":[{"merchant_id":"K5","name":"x","address":"y"}]}' }];
sandbox.pullFromKnot();
check("个人 token 用 x-knot-api-token", lastFetch.opt.headers["x-knot-api-token"] === "knot_xxx", lastFetch.opt.headers);
props.KNOT_USERNAME = "annika";
sandbox.pullFromKnot();
check("配了用户名 → agent token 模式（x-knot-token + X-Username）",
      lastFetch.opt.headers["x-knot-token"] === "knot_xxx" && lastFetch.opt.headers["X-Username"] === "annika", lastFetch.opt.headers);
check("请求体含 input.message", JSON.parse(lastFetch.opt.payload).input.message.length > 50);
delete props.KNOT_USERNAME;

/* ---------- 8. 提示词内容 ---------- */
console.log("\n=== 8. knotPrompt 契约 ===");
const p39 = sandbox.knotPrompt("2026-W39");
check("含 ISO 周次", p39.indexOf("2026-W39") >= 0);
check("含子商户进件", p39.indexOf("子商户进件") >= 0);
check("含物料激励铺设", p39.indexOf("物料激励铺设") >= 0);
check("含完整字段清单", ["merchant_id", "name", "category", "institution", "material", "address", "lat", "lng"].every(f => p39.indexOf(f) >= 0));
// 现在允许正文里有汇报（agent 主体是 Excel/Markdown），靠哨兵块把 JSON 框出来
check("用哨兵块框住 JSON（开始标记）", p39.indexOf("<<<KNOT_JSON>>>") >= 0);
check("用哨兵块框住 JSON（结束标记）", p39.indexOf("<<<END_KNOT_JSON>>>") >= 0);
check("明确禁止坐标填 0", p39.indexOf("不要填 0") >= 0);

/* ---------- 9. weeklyRefresh 串联 ---------- */
console.log("\n=== 9. weeklyRefresh 带 pull ===");
FAKE_RESP = [{ code: 200, text: '{"rows":[{"merchant_id":"K6","name":"x","address":"y"}]}' }];
const wr = sandbox.weeklyRefresh();
check("weeklyRefresh 返回含 pull 字段", wr.pull !== undefined && typeof wr.pull.ok === "boolean", wr.pull);
check("pull 成功（received=1）", wr.pull.ok === true && wr.pull.received === 1, wr.pull);

console.log("\n=== 汇总 ===");
console.log("  PASS: " + pass + "   FAIL: " + fail);
process.exit(fail ? 1 : 0);
