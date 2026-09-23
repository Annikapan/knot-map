/**
 * Pipeline.gs（数据处理・突合层）的本地自检
 * 用法：node gas/test_pipeline.js
 * 用假的 Apps Script 环境把归一化 / 匹配 / 坐标补全 / 打标 / 写表 真跑一遍
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

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
  SHEET_ID: "KNOT_SHEET", WEBHOOK_TOKEN: "tok123", MAPS_API_KEY: "",
  SPOT_SHEET_ID: "SPOT_SHEET", SPOT_SHEET_NAME: "踩点",
  GEO_RADIUS: "50", GEOCODE_ENABLED: "1", GEOCODE_KEY: "",
  INCENTIVE_AREAS: "東京都,大阪府,北海道",
  AREA_RULES: JSON.stringify({ "浅草": ["浅草"], "心斋桥": ["心斎橋", "道頓堀"] }),
  GITHUB_OWNER: "", GITHUB_REPO: "", GITHUB_TOKEN: ""
};
const fetchLog = [];

function fakeFetch(url, opt) {
  fetchLog.push({ url: String(url).slice(0, 60), method: (opt && opt.method) || "get" });
  if (/maps\/api\/geocode\/json/.test(url)) {           // Geocoding API
    const q = decodeURIComponent((String(url).match(/address=([^&]+)/) || [])[1] || "");
    const known = { "東京都台東区浅草5-5-5": { lat: 35.7200, lng: 139.8000 } };
    const hit = known[q];
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(hit
        ? { status: "OK", results: [{ geometry: { location: { lat: hit.lat, lng: hit.lng } } }] }
        : { status: "ZERO_RESULTS", results: [] })
    };
  }
  return { getResponseCode: () => 404, getContentText: () => "{}" };
}

const sandbox = {
  console, JSON, Date, Math, String, Number, Object, Array, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, RegExp, Error,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || "" }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  SpreadsheetApp: {
    openById(id) {
      if (!SHEETS[id]) SHEETS[id] = {};
      const box = SHEETS[id];
      return {
        getSheetByName: n => box[n] || null,
        insertSheet(n) { const s = makeSheet(); box[n] = s; return s; },
        getSheets() { return Object.keys(box).map(k => box[k]); }
      };
    }
  },
  ContentService: {
    createTextOutput: t => ({ text: t, setMimeType() { return this; } }),
    MimeType: { JSON: "application/json" }
  },
  HtmlService: {
    createTemplateFromFile: () => ({ evaluate() { return { setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } }; } }),
    XFrameOptionsMode: { ALLOWALL: "ALLOWALL" }
  },
  UrlFetchApp: { fetch: fakeFetch },
  Utilities: {
    newBlob: t => ({ getBytes: () => Buffer.from(String(t), "utf8") }),
    base64Encode: b => Buffer.from(b).toString("base64")
  },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }),
    deleteTrigger() {}, WeekDay: { MONDAY: "MONDAY" }
  }
};
// ※ Maps はあえて未定義（GAS 内蔵が使えない環境でも動くことを同時に検証する）

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8"), sandbox, { filename: "Code.gs" });
vm.runInContext(fs.readFileSync(path.join(__dirname, "Pipeline.gs"), "utf8"), sandbox, { filename: "Pipeline.gs" });

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log("  [OK] " + label); }
  else { fail++; console.log("  [FAIL] " + label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function putSheet(id, name, objects) {
  if (!SHEETS[id]) SHEETS[id] = {};
  const sh = makeSheet();
  const head = Object.keys(objects[0] || {});
  sh.rows = [head.slice()].concat(objects.map(o => head.map(h => (o[h] === undefined ? "" : o[h]))));
  SHEETS[id][name] = sh;
  return sh;
}

console.log("\n=== 1. 归一化（v2 规则：NFKC / 去前缀 / 反推 / 多解不改）===");
check("(株) 前缀被去掉",
  sandbox.normName("(株)浅草 店A") === sandbox.normName("株式会社浅草店A"),
  [sandbox.normName("(株)浅草 店A"), sandbox.normName("株式会社浅草店A")]);
check("全角→半角、大小写统一", sandbox.normName("ＡＢＣ　店") === "abc店", sandbox.normName("ＡＢＣ　店"));
check("地址：邮编被去掉", sandbox.normAddr("〒111-0032 東京都台東区浅草1-1-1") === "東京都台東区浅草1-1-1", sandbox.normAddr("〒111-0032 東京都台東区浅草1-1-1"));
check("地址：１丁目１番１号 ⇔ 1-1-1 统一（反推）",
  sandbox.normAddr("東京都台東区浅草１丁目１番１号") === sandbox.normAddr("東京都台東区浅草1-1-1"),
  [sandbox.normAddr("東京都台東区浅草１丁目１番１号"), sandbox.normAddr("東京都台東区浅草1-1-1")]);
check("地址：末尾楼层多解不改（保持原样）",
  sandbox.normAddr("東京都台東区浅草1-1-1 3F").indexOf("3f") >= 0, sandbox.normAddr("東京都台東区浅草1-1-1 3F"));

console.log("\n=== 2. 相似度 / 距离 ===");
check("完全相同 → 1", sandbox.sim("abc", "abc") === 1);
check("完全不同 → 0", sandbox.sim("abc", "xyz") === 0);
check("部分相似介于 0–1", sandbox.sim("浅草店a", "浅草店b") > 0.3 && sandbox.sim("浅草店a", "浅草店b") < 1, sandbox.sim("浅草店a", "浅草店b"));
const d = sandbox.haversine(35.7148, 139.7967, 35.7148, 139.7977);   // 経度 +0.001°
check("経度 +0.001° ≈ 90m（误差 30% 内）", d > 60 && d < 120, d);

console.log("\n=== 3. 踩点表 vs Knot：三级匹配 ===");
// 踩点表：写法随便（全角、带法人前缀、列名中文）
putSheet("SPOT_SHEET", "踩点", [
  { "店名": "(株)浅草 店A", "住所": "東京都台東区浅草１丁目１番１号", "纬度": 35.7148, "经度": 139.7967, "分类": "药妆" },
  { "店名": "浅草 店B",     "住所": "東京都台東区浅草2-2-2",         "纬度": 35.7155, "经度": 139.7980, "分类": "餐饮" },
  { "店名": "只踩过没铺的店", "住所": "東京都台東区浅草3-3-3",       "纬度": 35.7165, "经度": 139.7995, "分类": "零售" },
  { "店名": "没坐标待补的店", "住所": "東京都台東区浅草5-5-5",       "纬度": "",      "经度": "",        "分类": "景点" },
  { "店名": "地址查不到的店", "住所": "不明",                         "纬度": "",      "经度": "",        "分类": "其他" }
]);
// Knot：同一家店 A 写法不同（去掉法人前缀 + 半角地址）→ 应 L2 exact 命中
const knot = [
  { week: "2026-W39", merchant_id: "M001", name: "浅草店A", category: "已铺KIOSK", institution: "OS", material: "汇率物料", address: "東京都台東区浅草1-1-1", lat: 35.7148, lng: 139.7967 },
  { week: "2026-W39", merchant_id: "M002", name: "浅草店B", category: "已查商户", institution: "Tierra", material: "礼包物料", address: "東京都台東区浅草2-2-2", lat: 35.7155, lng: 139.7980 },
  { week: "2026-W39", merchant_id: "M009", name: "只铺过没踩的店", category: "已铺PP logo", institution: "LIAN", material: "汇率物料", address: "東京都台東区浅草9-9-9", lat: 35.7190, lng: 139.8020 }
];
const mm = sandbox.matchAndMerge(sandbox.readSpotRows().rows, knot.map(sandbox.toStd));
console.log("  stats:", JSON.stringify(mm.stats));
check("店A 写法不同也命中（exact）", mm.stats.exact >= 1, mm.stats);
check("店B 命中", mm.stats.both >= 2, mm.stats);
check("both = 2（店A + 店B）", mm.stats.both === 2, mm.stats);
check("spot-only = 3（只踩过 / 两个没坐标）", mm.stats.spotOnly === 3, mm.stats);
check("knot-only = 1（只铺过没踩的店）", mm.stats.knotOnly === 1, mm.stats);
check("总数 = 6（不是 5+3=8 的简单叠加）", mm.rows.length === 6, mm.rows.length);
const A = mm.rows.find(r => r.name.indexOf("店A") >= 0);
check("店A 合并后 match_status=both", A && A.match_status === "both", A && A.match_status);
check("店A 保留了踩点分类和 Knot 分类",
  A && A.spot_category === "药妆" && A.knot_category === "已铺KIOSK", A && [A.spot_category, A.knot_category]);

console.log("\n=== 4. L1 merchant_id 精确匹配 ===");
const mmId = sandbox.matchAndMerge(
  [sandbox.toStd({ "店名": "名字写错了", "住所": "東京都台東区浅草8-8-8", "纬度": 35.71, "经度": 139.79, "商户号": "M001" })],
  knot.map(sandbox.toStd));
check("店名地址都对不上、但商户号一样 → id 级命中", mmId.stats.id === 1, mmId.stats);

console.log("\n=== 5. L4 坐标就近匹配（50m 内 + 店名相似）===");
// 刻意让店名/地址都对不上（「本店」后缀），只剩坐标能救 → 必须走 geo 级
const mmGeo = sandbox.matchAndMerge(
  [sandbox.toStd({ "店名": "浅草ラーメン", "住所": "", "纬度": 35.71481, "经度": 139.79671 })],
  [sandbox.toStd({ name: "浅草ラーメン本店", address: "東京都台東区浅草1-1-1", lat: 35.71480, lng: 139.79670 })]);
check("店名地址都不全等、但 1m 内 + 店名相似 → geo 级命中", mmGeo.stats.geo === 1, mmGeo.stats);
// 距离 500m → 超出默认半径，不该命中
const mmFar = sandbox.matchAndMerge(
  [sandbox.toStd({ "店名": "浅草ラーメン", "住所": "", "纬度": 35.71481, "经度": 139.79671 })],
  [sandbox.toStd({ name: "浅草ラーメン本店", address: "", lat: 35.7193, lng: 139.7967 })]);
check("距离 500m 超出半径 → 不误匹配", mmFar.stats.geo === 0 && mmFar.stats.both === 0, mmFar.stats);

console.log("\n=== 6. 端到端 buildMerged（含坐标补全 + 打标 + 写表）===");
putSheet("KNOT_SHEET", "明细", knot);       // 先把 Knot 存档放进 Sheet
props.GEOCODE_KEY = "FAKE_GEO_KEY";        // 走 Geocoding API 分支（Maps 服务在本环境未定义）
const r = sandbox.buildMerged();
console.log("  buildMerged:", JSON.stringify(r));
check("踩点 5 行 + Knot 3 行 → 合并 6 行", r.merged === 6, r.merged);
check("坐标补全：能查到的补上了", r.geocode.ok === 1, r.geocode);
check("坐标补全：查不到的记为失败（不瞎猜）", r.geocode.failed === 1, r.geocode);
check("能上图的 5 行（查不到坐标那家不上图）", r.plottable === 5, r.plottable);
check("待人工校对里躺着查不到坐标的那家", r.review === 1, r.review);

const merged = sandbox.readMerged();
check("「合并」Sheet 写出来了（5 行）", merged.length === 5, merged.length);
const rv = sandbox.readReviewRows();
check("「待人工校对」写明原因 = 座標なし", rv.length === 1 && rv[0].why === "座標なし", rv);
const withGeo = merged.find(x => x.name.indexOf("没坐标待补的店") >= 0);
check("补出来的坐标落到了表上（geocoded=1）", withGeo && withGeo.geocoded === 1 && withGeo.lat, withGeo && [withGeo.lat, withGeo.lng, withGeo.geocoded]);
check("都道府県被抽出", merged.every(x => x.prefecture === "東京都"), merged.map(x => x.prefecture));
check("激励区域打标（東京都 在清单内）", merged.every(x => x.incentive === "激励対象"), merged.map(x => x.incentive));
check("商圈打标（浅草 关键词命中）", merged.filter(x => x.area === "浅草").length === 5, merged.map(x => x.area));

console.log("\n=== 7. 前端读取：doGet(?format=json) ===");
const j1 = JSON.parse(sandbox.doGet({ parameter: { format: "json" } }).text);
check("默认 view=merged，返回 5 行", j1.view === "merged" && j1.rows.length === 5, [j1.view, j1.total]);
const j0 = JSON.parse(sandbox.doGet({ parameter: { format: "json", view: "spot" } }).text);
check("view=spot → 踩点源 5 行（列名是中文也认得）", j0.view === "spot" && j0.rows.length === 5, [j0.view, j0.total]);
check("行里带 match_status（前端可直接当配色维度）",
  j1.rows[0].match_status !== undefined, Object.keys(j1.rows[0]));
const j2 = JSON.parse(sandbox.doGet({ parameter: { format: "json", view: "raw" } }).text);
check("view=raw → Knot 原始 3 行", j2.view === "raw" && j2.rows.length === 3, [j2.view, j2.total]);
const j3 = JSON.parse(sandbox.doGet({ parameter: { format: "json", view: "review" } }).text);
check("view=review → 待人工校对", j3.view === "review" && Array.isArray(j3.rows), [j3.view, j3.total]);
const gp = sandbox.getPoints();
check("getPoints 优先读「合并」（5 行且跳过了 0 行）", gp.rows.length === 5 && gp.skipped === 0, [gp.rows.length, gp.skipped]);

console.log("\n=== 8. doPost 全链路（Knot 推送 → 存档 → 突合 → 出图）===");
putSheet("KNOT_SHEET", "明细", []);        // 清空 Knot 存档重来
SHEETS["KNOT_SHEET"]["合并"] && delete SHEETS["KNOT_SHEET"]["合并"];
const resp = JSON.parse(sandbox.doPost({
  parameter: { token: "tok123" }, headers: {}, postData: { contents: JSON.stringify(knot) }
}).text);
console.log("  resp.merged:", JSON.stringify(resp.merged && resp.merged.match), " plottable:", resp.merged && resp.merged.plottable);
check("doPost 返回 ok", resp.ok === true, resp.error);
check("doPost 顺带完成了突合（both=2）", resp.merged && resp.merged.match.both === 2, resp.merged && resp.merged.match);
check("GitHub 未配置时不发请求（skipped）",
  resp.github.merged.skipped === "github not configured", resp.github);

console.log("\n=== 汇总 ===");
console.log("  PASS:", pass, "  FAIL:", fail);
console.log("  网络请求（只有 Geocoding 应有调用）:", JSON.stringify(fetchLog));
process.exit(fail ? 1 : 0);
