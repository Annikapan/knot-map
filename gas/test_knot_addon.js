/**
 * 现有跑数 agent（任务C 增量片段）对接自检 —— node gas/test_knot_addon.js
 *
 * 背景：agent 那份 prompt 主体是 Excel + Markdown 汇报，不可能「只输出 JSON」。
 * 所以数据块用哨兵 <<<KNOT_JSON>>> ... <<<END_KNOT_JSON>>> 包起来，
 * 这里验证 GAS 能从混合正文里截出来、能合并分片、能识别被截断。
 *
 * 覆盖：单块 / 多块 / 混合正文 / 截断 / 坏块 / 回退纯JSON / total_rows / 分片POST / 无id去重
 */
const fs = require("fs"), vm = require("vm"), path = require("path");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  [OK] " + label); }
  else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

/* ---------- GAS 环境 mock ---------- */
const props = { SHEET_ID: "S", WEBHOOK_TOKEN: "tok123", KNOT_AGENT_URL: "https://knot/a", KNOT_AGENT_TOKEN: "k" };
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

const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt,
  encodeURIComponent, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  SpreadsheetApp: { openById(id) {
    if (!SHEETS[id]) SHEETS[id] = {};
    const b = SHEETS[id];
    return { getSheetByName: n => b[n] || null, insertSheet(n) { const s = makeSheet(); b[n] = s; return s; }, getSheets: () => Object.keys(b).map(k => b[k]) };
  } },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => "{}" }) },
  Utilities: { newBlob: () => ({ getBytes: () => Buffer.from("") }), base64Encode: () => "" },
  ContentService: { createTextOutput: t => ({ text: t, setMimeType() { return this; } }), MimeType: {} },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } }) }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }), deleteTrigger() {}, WeekDay: {} }
};
vm.createContext(sandbox);
["Code.gs", "Pipeline.gs"].forEach(f =>
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f }));

const B = "<<<KNOT_JSON>>>", E = "<<<END_KNOT_JSON>>>";
const row = (id, name, addr, extra) => Object.assign({
  week: "2026-W38", merchant_id: id, name: name, category: "已铺设礼包或汇率",
  institution: "OS", material: "礼包物料", address: addr, lat: "", lng: "", note: ""
}, extra || {});
const wrap = o => B + "\n" + JSON.stringify(o) + "\n" + E;

/* ---------- 1. 单块 ---------- */
console.log("\n=== 1. 单个哨兵块 ===");
let r = sandbox.parseKnotPayload(wrap({ ok: true, week: "2026-W38", total_rows: 2,
  rows: [row("MAT1001", "浅草 店A", "東京都台東区浅草1-1-1"), row("MAT1002", "浅草 店B", "東京都台東区浅草2-2-2")] }));
check("解析出 2 行", r && r.rows.length === 2, r && r.rows.length);
check("chunks = 1", r.chunks === 1, r.chunks);
check("total_rows 透传", r.total_rows === 2, r.total_rows);
check("week 透传", r.week === "2026-W38", r.week);

/* ---------- 2. 多块分片 ---------- */
console.log("\n=== 2. 多块分片（>300 行拆块）===");
const multi = [
  wrap({ ok: true, week: "2026-W38", total_rows: 4, rows: [row("MAT1", "店1", "番地1"), row("MAT2", "店2", "番地2")] }),
  wrap({ ok: true, week: "2026-W38", rows: [row("MAT3", "店3", "番地3"), row("MAT4", "店4", "番地4")] })
].join("\n");
r = sandbox.parseKnotPayload(multi);
check("两块合并成 4 行", r && r.rows.length === 4, r && r.rows.length);
check("chunks = 2", r.chunks === 2, r.chunks);
check("partial = false", r.partial === false, r.partial);

/* ---------- 3. 混合正文（Excel 说明 + Markdown 表 + 数据块） ---------- */
console.log("\n=== 3. 混合正文：前面是汇报，末尾是数据块 ===");
const report = [
  "本周新进件 1,234 家（新进件 -16.3%）。",
  "",
  "| 都道府県 | 件数 |",
  "|---|---|",
  "| 東京都 | 512 {不是JSON} |",
  "",
  "Excel 已生成：日本新进件_2026W38.xlsx",
  "",
  wrap({ ok: true, week: "2026-W38", rows: [row("MAT9", "_real店", "東京都_real")] })
].join("\n");
r = sandbox.parseKnotPayload(report);
check("只截哨兵块，不被正文里的 { } 干扰", r && r.rows.length === 1 && r.rows[0].name === "_real店", r && r.rows);

/* ---------- 4. 被平台截断 ---------- */
console.log("\n=== 4. 最后一块被截断（只有开始标记）===");
const cut = [
  wrap({ ok: true, week: "2026-W38", rows: [row("MAT1", "店1", "番地1")] }),
  B + '\n{"ok":true,"week":"2026-W38","rows":[{"merchant_id":"MAT2","name":"店2"'
].join("\n");
r = sandbox.parseKnotPayload(cut);
check("完整块照收（1 行）", r && r.rows.length === 1, r && r.rows.length);
check("partial = true（下游据此告警）", r && r.partial === true, r && r.partial);

/* ---------- 5. 坏块 ---------- */
console.log("\n=== 5. 其中一块是坏 JSON ===");
const bad = [
  B + "\n{这不是 json}\n" + E,
  wrap({ ok: true, week: "2026-W38", rows: [row("MAT7", "店7", "番地7")] })
].join("\n");
r = sandbox.parseKnotPayload(bad);
check("坏块跳过，好块照收", r && r.rows.length === 1 && r.rows[0].merchant_id === "MAT7", r && r.rows);

/* ---------- 6. 回退：旧 prompt 只吐纯 JSON ---------- */
console.log("\n=== 6. 没有哨兵 → 回退兼容旧格式 ===");
r = sandbox.parseKnotPayload('{"ok":true,"rows":[{"merchant_id":"OLD1","name":"旧格式店","address":"x"}]}');
check("纯 JSON 仍能解析", r && r.rows.length === 1 && r.rows[0].merchant_id === "OLD1", r && r.rows);
r = sandbox.parseKnotPayload("本周数据我已经帮你查好了，请问还需要什么帮助？");
check("闲聊文本 → null（可诊断）", r === null, r);

/* ---------- 7. knotPrompt 契约 ---------- */
console.log("\n=== 7. knotPrompt 用哨兵格式 ===");
const p = sandbox.knotPrompt("2026-W38");
check("含开始哨兵", p.indexOf(B) >= 0);
check("含结束哨兵", p.indexOf(E) >= 0);
check("指明 300 行分片", p.indexOf("300") >= 0);
check("仍禁止坐标填 0", p.indexOf("不要填 0") >= 0);

/* ---------- 8. doPost 分片 ---------- */
console.log("\n=== 8. doPost 分片：中间片不触发突合 ===");
let mergeCalls = 0;
sandbox.buildMerged = () => { mergeCalls++; return { plottable: 0, merged: 0, match: {}, geocode: {} }; };
sandbox.geocodeMissing = () => ({ tried: 0, ok: 0, failed: [] });
sandbox.readMerged = () => [];

const e1 = { parameter: { token: "tok123" }, postData: { contents: JSON.stringify({
  ok: true, week: "2026-W38", total_rows: 4, chunk: { i: 1, n: 2 },
  rows: [row("MAT1", "店1", "番地1"), row("MAT2", "店2", "番地2")] }) } };
const o1 = JSON.parse(sandbox.doPost(e1).text);
check("片1 ok:true", o1.ok === true && o1.added === 2, o1);
check("片1 merged = null（不做突合）", o1.merged === null, o1.merged);
check("片1 未调用 buildMerged", mergeCalls === 0, mergeCalls);

const e2 = { parameter: { token: "tok123" }, postData: { contents: JSON.stringify({
  ok: true, week: "2026-W38", chunk: { i: 2, n: 2 },
  rows: [row("MAT3", "店3", "番地3"), row("MAT4", "店4", "番地4")] }) } };
const o2 = JSON.parse(sandbox.doPost(e2).text);
check("片2 ok:true 且触发突合", o2.ok === true && o2.merged !== null, o2);
check("buildMerged 只被调 1 次", mergeCalls === 1, mergeCalls);
check("total = 4（两片都入库）", o2.total === 4, o2.total);

/* ---------- 9. 无 merchant_id 的行不被互相覆盖 ---------- */
console.log("\n=== 9. 无 merchant_id 的行按「店名|地址」去重 ===");
const e3 = { parameter: { token: "tok123" }, postData: { contents: JSON.stringify({
  ok: true, week: "2026-W39",
  rows: [row("", "店X", "番地X"), row("", "店Y", "番地Y"), row("", "店Z", "番地Z")] }) } };
const o3 = JSON.parse(sandbox.doPost(e3).text);
check("3 条无 id 的行都保留（不是只剩最后一条）", o3.total === 7, o3.total);

console.log("\n=== 汇总 ===");
console.log("  PASS: " + pass + "   FAIL: " + fail);
process.exit(fail ? 1 : 0);
