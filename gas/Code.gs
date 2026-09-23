/**
 * Knot 定时结果 -> Google Sheet 存档 -> GitHub data.json -> 地图页
 *
 * 本脚本同时承担三件事：
 *   A. 接收 Knot 的 webhook（doPost）-> 写 Sheet 存档 -> 更新 GitHub data.json
 *   B. 托管地图页（doGet + MapPage.html）-> /exec 就是永久固定的地图链接
 *   C. 对外吐 JSON（doGet?format=json）-> 给静态页 points.html 当数据源
 *
 * 部署方式：
 *   1. 新建 Google Sheet（tab 名：明细），把 spreadsheetId 填到脚本属性 SHEET_ID
 *   2. 扩展程序 -> Apps Script，粘贴本文件；再新建 HTML 文件「MapPage」粘贴 MapPage.html
 *   3. 项目设置 -> 脚本属性：
 *        SHEET_ID（必须） / MAPS_API_KEY（地図用） / WEBHOOK_TOKEN（POST 鉴权）
 *        GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO（只在需要同步 GitHub 时填）
 *   4. 部署 -> 新建部署 -> 网页应用：执行者=我，访问权限=任何人
 *   5. 复制 /exec 地址：这就是地图链接（固定不变）；填到 Knot 的 webhook 里则是接收端
 *
 * GitHub 上生成 PAT：Settings -> Developer settings -> Tokens (classic) -> 勾选 repo
 */

const P = () => PropertiesService.getScriptProperties();

const COLS = ["week","merchant_id","name","category","institution","material","address","lat","lng","note"];

/**
 * webhook 入口：Knot 每周跑完 POST 到这里
 * 鉴权：URL 带 ?token=xxx 或 header x-knot-token
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out({ ok:false, error:"busy" });

  try {
    const props = P();
    const given = (e.parameter && e.parameter.token) || (e.headers && e.headers["x-knot-token"]) || "";
    if (given !== props.getProperty("WEBHOOK_TOKEN")) {
      return out({ ok:false, error:"unauthorized" });
    }

    let payload;
    try { payload = JSON.parse(e.postData.contents); }
    catch (err) { return out({ ok:false, error:"invalid json" }); }

    const rows = normalize(payload);
    if (!rows.length) return out({ ok:false, error:"no rows" });

    const added = appendRows(rows);          // 1) 追加进 Sheet 存档
    const all   = readAll();                 // 2) 读全量（含去重：同 merchant_id 只留最新）
    const merge = buildMerged();             // 3) 处理层：踩点 × Knot 匹配 → 「合并」Sheet
    const res   = updateGitHubFile(merge.plottable ? readMerged() : all, "merged.json");
    const res2  = updateGitHubFile(all, "data.json");   // 原始 Knot 存档也留一份

    return out({ ok:true, received:rows.length, added:added, total:all.length,
                 merged:merge, github:{ merged:res, raw:res2 } });

  } catch (err) {
    return out({ ok:false, error:String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * ブラウザから開く入口。2役ある：
 *   1) そのまま開く -> HtmlService で地図ページ（MapPage.html）を返す＝固定リンク
 *   2) ?format=json -> 生データを JSON で返す（外部の静的ページ points.html から読む用）
 * どちらも Sheet は非公開のままで動く。
 */
function doGet(e) {
  const fmt = (e && e.parameter && (e.parameter.format || e.parameter.f)) || "";
  if (fmt === "json") {
    // view=merged（默认，处理层输出）/ raw（Knot 原始存档）/ spot（踩点源）/ review（待人工校对）
    const view = (e.parameter && e.parameter.view) || "merged";
    if (view === "raw")    { const a = readAll();    return out({ ok:true, view:"raw",    total:a.length, rows:a }); }
    if (view === "spot")   { const s = readSpotRows(); return out({ ok:true, view:"spot", total:s.rows.length, rows:s.rows.map(r => r.raw) }); }
    if (view === "review") { const v = readReviewRows(); return out({ ok:true, view:"review", total:v.length, rows:v }); }
    let m = readMerged();
    // 「合并」还没建（比如踩点源没配）时，退回 Knot 原始存档，保证地图永远不空
    const isMerged = m.length > 0;
    let rows = isMerged ? m : readAll();

    // 下钻过滤：几万点不可能一次全塞给浏览器，按都道府県/商圈/突合状态切
    const q = e.parameter || {};
    const filt = (v, key) => { if (!v) return; rows = rows.filter(r => String(r[key]) === v); };
    filt(q.pref, "prefecture"); filt(q.area, "area");
    filt(q.status, "match_status"); filt(q.institution, "institution");
    if (q.q) { const s = String(q.q).toLowerCase();
      rows = rows.filter(r => (String(r.name) + String(r.address) + String(r.merchant_id)).toLowerCase().indexOf(s) >= 0); }

    return out({ ok:true, view: isMerged ? "merged" : "raw", total: rows.length, rows: rows });
  }
  const t = HtmlService.createTemplateFromFile("MapPage");
  t.apiKey = P().getProperty("MAPS_API_KEY") || "";
  return t.evaluate()
          .setTitle("物料铺设マップ")
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
          .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/** 地図ページ（google.script.run）から呼ばれる：突合済み「合并」を優先して返す */
function getPoints() {
  let rows = readMerged();
  if (!rows.length) rows = readAll();          // 「合并」未作成なら Knot 原本にフォールバック
  const valid = rows.filter(function (r) { return isFinite(parseFloat(r.lat)) && isFinite(parseFloat(r.lng)); });
  return { rows: valid, skipped: rows.length - valid.length, updated: new Date().toISOString() };
}

/** 手動実行用：今すぐ突合をやり直す（Apps Script エディタから実行） */
function refreshMerged() { return buildMerged(); }

/** 「待人工校对」Sheet を読む */
function readReviewRows() {
  const ss = SpreadsheetApp.openById(P().getProperty("SHEET_ID"));
  const sh = ss.getSheetByName("待人工校对");
  if (!sh || sh.getLastRow() < 2) return [];
  return sheetToObjects(sh);
}

/** 毎週の自動更新トリガー（Knot が push できない場合の保険）：毎週月曜 09:00 に実行 */
function installWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "weeklyRefresh") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("weeklyRefresh").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
}

function weeklyRefresh() {
  const pull  = pullFromKnot();                // Knot が push してくれない週の保険（未設定なら skip）
  const merge = buildMerged();                 // 踩点 + Knot 重新突合
  const rows  = readMerged();
  const res   = updateGitHubFile(rows, "merged.json");
  const res2  = updateGitHubFile(readAll(), "data.json");
  return { pull: pull, merged: merge, total: rows.length, github: { merged: res, raw: res2 } };
}

/* ============================================================
   Knot 主动拉取（Knot 侧无法定时推送时的兜底）
   —— 需要 脚本属性：KNOT_AGENT_URL / KNOT_AGENT_TOKEN（+ agent token 模式要 KNOT_USERNAME）
   —— 没配就自动跳过，不影响 Knot 主动推送那条路
   ============================================================ */

/** 给 Knot agent 的取数指令。关键是「只吐 JSON」，否则 GAS 解析不出来。 */
function knotPrompt(week) {
  return [
    "请提取 ISO 周次 " + week + "（上一自然周）日本市场的两类数据，只输出 JSON，不要任何解释文字、不要 markdown 代码块：",
    "1) 子商户进件：本周新完成进件的子商户",
    "2) 物料激励铺设：本周完成物料铺设的商户",
    "字段固定为：week, merchant_id, name, category, institution, material, address, lat, lng, note",
    "week 统一填 " + week + "；category 用数据里的状态口径；lat/lng 没有就填空字符串（不要填 0，不要猜）。",
    "输出结构：{\"ok\":true,\"week\":\"" + week + "\",\"rows\":[ ... ]}"
  ].join("\n");
}

/**
 * 调 Knot AGUI API 取数 → 写进 Sheet 存档。
 * 返回 { ok, week, received, added } 或 { ok:false, skipped:true, reason }
 */
function pullFromKnot(opt) {
  opt = opt || {};
  const p     = P();
  const url   = p.getProperty("KNOT_AGENT_URL");
  const token = p.getProperty("KNOT_AGENT_TOKEN");

  if (!url || !token) {
    return { ok:false, skipped:true, reason:"KNOT_AGENT_URL / KNOT_AGENT_TOKEN 未配置 → 依赖 Knot 主动推送" };
  }

  const week   = opt.week || isoWeek(new Date());
  const prompt = opt.prompt || p.getProperty("KNOT_PROMPT") || knotPrompt(week);
  const user   = p.getProperty("KNOT_USERNAME");
  const model  = p.getProperty("KNOT_MODEL") || "kimi-k2.5";

  // 个人 token：x-knot-api-token；agent token：x-knot-token + X-Username
  const headers = {};
  if (user) { headers["x-knot-token"] = token; headers["X-Username"] = user; }
  else      { headers["x-knot-api-token"] = token; }

  const body = { input: { message: prompt, conversation_id: "", model: model,
                          stream: false, enable_web_search: false, temperature: 0.2 } };

  let text;
  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post", contentType: "application/json",
      headers: headers, payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    if (code >= 400) return { ok:false, http: code, body: String(res.getContentText()).slice(0, 300) };
    text = res.getContentText();
  } catch (err) {
    return { ok:false, error: String(err) };
  }

  const parsed = parseKnotPayload(text);
  if (!parsed) return { ok:false, error:"解析不出 JSON（提示词要求「只输出 JSON」）", preview: String(text).slice(0, 300) };

  const rows = normalize(parsed);
  if (!rows.length) return { ok:false, error:"解析到 0 行", preview: String(text).slice(0, 300) };

  return { ok:true, week: week, received: rows.length, added: appendRows(rows) };
}

/**
 * agent 的返回可能是 ① 纯 JSON ② SSE 流（data: {...}）③ 带 ```json 围栏的文本。
 * 三种都试一遍，抽成对象；抽不出来返回 null。
 */
function parseKnotPayload(text) {
  if (!text) return null;
  let s = String(text).trim();

  const looksRows = o => o && (Array.isArray(o) || o.rows || o.data || o.records);
  try { const o = JSON.parse(s); if (looksRows(o)) return o; } catch (e) {}

  // SSE：拼所有 TEXT_MESSAGE_CONTENT 的 content
  if (s.indexOf("data:") >= 0 || s.indexOf("TEXT_MESSAGE_CONTENT") >= 0) {
    let buf = "";
    s.split("\n").forEach(function (line) {
      line = String(line).trim();
      if (line.indexOf("data:") === 0) line = line.slice(5).trim();
      if (!line || line === "[DONE]") return;
      let m; try { m = JSON.parse(line); } catch (e) { return; }
      if (m && m.type === "TEXT_MESSAGE_CONTENT" && m.rawEvent && m.rawEvent.content) buf += m.rawEvent.content;
    });
    if (buf) s = buf.trim();
  }

  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { const o = JSON.parse(s); return looksRows(o) ? o : null; }
  catch (e) { return null; }
}

/** 手动验证用：Apps Script 编辑器里直接跑，看能不能打通 Knot */
function testKnotPull() {
  const r = pullFromKnot();
  console.log(JSON.stringify(r, null, 2));
  return r;
}

/* ---------- 字段映射：等 Knot 输出样例确定后改这里 ---------- */
function normalize(payload) {
  const list = Array.isArray(payload) ? payload
             : (payload.rows || payload.data || payload.records || []);
  // 座標が無い行も「落とさない」。空欄のまま残し、Pipeline の住所ジオコーディングで補う。
  const num = function (v) { const n = parseFloat(v); return isFinite(n) ? n : ""; };
  return list.map(function (r) {
    return {
      week:        r.week || isoWeek(new Date()),
      merchant_id: r.merchant_id || r.id || r.merchantId || "",
      name:        r.name || r.merchant_name || r.store || "",
      category:    r.category || r.type || "全部商户",
      institution: r.institution || r.org || r.agent || "",
      material:    r.material || "",
      address:     r.address || r.addr || "",
      lat:         num(r.lat ?? r.latitude),
      lng:         num(r.lng ?? r.longitude),
      note:        r.note || r.remark || ""
    };
  }).filter(function (r) { return r.name || r.merchant_id || r.address; });  // 全項目カラ行だけ捨てる
}

/* ---------- Sheet：追加存档 ---------- */
function appendRows(rows) {
  const ss = SpreadsheetApp.openById(P().getProperty("SHEET_ID"));
  const sh = ss.getSheetByName("明细") || ss.insertSheet("明细");
  if (sh.getLastRow() === 0) sh.appendRow(COLS);
  const values = rows.map(function (r) { return COLS.map(function (c) { return r[c]; }); });
  sh.getRange(sh.getLastRow() + 1, 1, values.length, COLS.length).setValues(values);
  return values.length;
}

/* ---------- 全量读取：同 merchant_id 保留最新一条 ---------- */
function readAll() {
  const ss = SpreadsheetApp.openById(P().getProperty("SHEET_ID"));
  const sh = ss.getSheetByName("明细");
  if (!sh || sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, COLS.length).getValues();
  const map = {};
  data.forEach(function (row) {
    const r = {};
    COLS.forEach(function (c, i) { r[c] = row[i]; });
    if (!r.merchant_id) return;
    const prev = map[r.merchant_id];
    if (!prev || String(r.week) >= String(prev.week)) map[r.merchant_id] = r;
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

/* ---------- 更新 GitHub 上的 data.json ---------- */
function updateGitHubFile(rows, path) {
  const p = P();
  const owner = p.getProperty("GITHUB_OWNER");
  const repo  = p.getProperty("GITHUB_REPO");
  const token = p.getProperty("GITHUB_TOKEN");
  if (!owner || !repo || !token) return { skipped: "github not configured" };   // 未配置就别白跑一次网络请求
  path = path || "data.json";
  const api   = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + path;
  const headers = {
    Authorization: "token " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "knot-apps-script"
  };

  let sha = null;
  try {
    const cur = UrlFetchApp.fetch(api, { method:"get", headers:headers, muteHttpExceptions:true });
    if (cur.getResponseCode() === 200) sha = JSON.parse(cur.getContentText()).sha;
  } catch (err) {}

  const body = {
    message: "weekly update " + new Date().toISOString().slice(0,10) + " (" + rows.length + " rows)",
    content: base64(JSON.stringify(rows, null, 1)),
    sha: sha || undefined
  };

  const resp = UrlFetchApp.fetch(api, {
    method: sha ? "put" : "put",
    headers: headers,
    contentType: "application/json",
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  return { status: resp.getResponseCode(), body: resp.getContentText().slice(0, 200) };
}

function base64(text) {
  const bytes = Utilities.newBlob(text, "text/plain", "UTF-8").getBytes();
  return Utilities.base64Encode(bytes);
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + String(wk).padStart(2, "0");
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
