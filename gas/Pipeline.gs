/**
 * Pipeline.gs — データ処理・突合層（数据源 → 地图页 之间的那一层）
 *
 * 位置：
 *   踩点 Google Sheets ┐
 *                      ├─→ Pipeline.gs（归一化 → 匹配 → 坐标补全 → 打标）→ 「合并」Sheet → 地图页
 *   Knot → 明细 Sheet ─┘
 *
 * 为什么放在 GAS：
 *   ① 已经是 Knot 数据的必经之路，踩点数据顺手就能拉进来
 *   ② 口径改了不用重新部署前端页面，改脚本即可
 *   ③ 中间结果落在 Sheet 里，可以人工修正
 *
 * 需要在「项目设置 → 脚本属性」里配置（都可选，缺哪个就跳过对应能力）：
 *   SPOT_SHEET_ID    踩点 Sheets 的 ID（推荐。表可以保持私有，只要共享给脚本所有者）
 *   SPOT_SHEET_NAME  踩点表的 tab 名（不填则取第一个 tab）
 *   SPOT_CSV_URL     备选：踩点表「发布到网络」的 CSV 链接（与上面二选一）
 *   GEOCODE_ENABLED  1/0，是否给缺坐标的行补坐标（默认 1）
 *   GEOCODE_KEY      Geocoding 用的 key（可选；不填则用 GAS 内置 Maps 服务）
 *   GEO_RADIUS       坐标就近匹配半径（米，默认 50）
 *   INCENTIVE_AREAS  激励区域清单（逗号分隔，例：東京都,大阪府,北海道）
 *   AREA_RULES       商圈打标规则 JSON：{"心斋桥":["心斎橋","道頓堀"],"浅草":["浅草"]}
 */

/* ============================================================
   1. 通用工具
   ============================================================ */

/** 全角/半角统一（v2 规则①：NFKC） */
function nfkc(s) {
  s = (s === null || s === undefined) ? "" : String(s);
  try { return s.normalize("NFKC"); } catch (e) { return s; }
}

/** 法人前缀 / 括号 / 空白 / 句读 全部去掉，只留可比的骨架（v2 规则②：去前缀） */
const CORP_RE = /^(株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|\(有\)|（有）|㈱|㈲|㈴|Co\.,?\s*Ltd\.?|Ltd\.?|Inc\.?|Corp\.?|K\.K\.)/i;
function normName(s) {
  let t = nfkc(s).trim();
  t = t.replace(CORP_RE, "");                 // 去法人前缀
  t = t.replace(/[（）()\[\]【】〔〕]/g, "");   // 去括号
  t = t.replace(/[\s\u3000]+/g, "");          // 去所有空白
  t = t.replace(/[‐-―−–—ー]/g, "-");          // 连字符统一成半角 -
  t = t.replace(/[・･.,、，]/g, "");           // 去句读
  return t.toLowerCase();
}

/**
 * 地址归一化（v2 规则：NFKC / 去前缀 / 反推 / 多解不改）
 *   去前缀：邮编、国名
 *   反推  ：「1丁目2番3号」⇔「1-2-3」统一成后者
 *   多解不改：末尾的楼层/号室无法唯一判定，保持原样不猜
 */
function normAddr(s) {
  let t = nfkc(s).trim();
  t = t.replace(/^〒?\s?\d{3}-?\d{4}\s*/, "");         // 邮编
  t = t.replace(/^(日本|Japan|Nihon)\s*/i, "");        // 国名
  t = t.replace(/[\s\u3000]+/g, "");
  t = t.replace(/(\d+)\s*丁目/g, "$1-");               // 1丁目 → 1-
  t = t.replace(/(\d+)\s*番(地?の?)?/g, "$1-");        // 2番  → 2-
  t = t.replace(/(\d+)\s*号/g, "$1");                  // 3号  → 3（接在上一个 - 后）
  t = t.replace(/-+/g, "-").replace(/^-|-$/g, "");     // 连续/末尾的连字符
  t = t.replace(/[・･]/g, "");
  return t.toLowerCase();
}

/** 匹配键：有地址就用「店名|地址」，没地址退化成「店名」 */
function keyOf(n, a) {
  const nn = normName(n), na = normAddr(a);
  return na ? (nn + "|" + na) : nn;
}

/**
 * 两段文字的相似度（bigram Dice 系数，0–1）。中文/日文都能用
 * ※ 追加「包含加成」：一边是另一边的子串时按覆盖率给分。
 *   実データで効いた例：「桃猫麻辣湯（ももねこマーラータン)」vs「桃猫麻辣湯」
 *   　→ 片側だけ括弧書きの読み仮名を落としていると Dice は 0.47 にしかならず取り逃す。
 *   　→ 短い方が長い方に丸ごと含まれるなら「同じ店の別表記」と判断して 0.55 以上を与える。
 */
function sim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bg = s => { const o = []; for (let i = 0; i < s.length - 1; i++) o.push(s.substr(i, 2)); return o; };
  const A = bg(a), B = bg(b);
  const setB = {};
  B.forEach(x => setB[x] = 1);
  let inter = 0;
  const setA = {};
  A.forEach(x => { if (!setA[x]) { setA[x] = 1; if (setB[x]) inter++; } });
  const uniqA = Object.keys(setA).length, uniqB = Object.keys(setB).length;
  const dice = (uniqA + uniqB) ? (2 * inter) / (uniqA + uniqB) : 0;

  const sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a;
  if (sh.length >= 3 && lo.indexOf(sh) >= 0) {          // 极短名（1–2 字）不算证据，避免误匹配
    const cover = sh.length / lo.length;
    if (cover >= 0.25) return Math.max(dice, 0.55 + 0.45 * cover);
  }
  return dice;
}

/** 两点距离（米） */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 坐标网格索引：把点按约 100m 的格子分桶，只比「本格 + 周围 8 格」。
 * 数万点规模下 L4（坐标就近）是全表两两比较，5万×5万 会直接撞上 GAS 的 6 分钟上限；
 * 加索引后退化成 O(n × 邻居数)，5万点也能秒级跑完。
 * ※ 经度 1° 的实际米数随纬度变短，所以按最保守的 cos45° 取值，保证不会漏格。
 */
const CELL_M_PER_DEG = 70000;
function buildGeoIndex(rows, cellDeg) {
  const g = {};
  rows.forEach((r, i) => {
    if (!isLL(r)) return;
    const k = Math.floor(r.lat / cellDeg) + ":" + Math.floor(r.lng / cellDeg);
    (g[k] = g[k] || []).push(i);
  });
  return g;
}
function nearbyCells(idx, lat, lng, cellDeg) {
  const cy = Math.floor(lat / cellDeg), cx = Math.floor(lng / cellDeg);
  const out = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const b = idx[(cy + dy) + ":" + (cx + dx)];
      if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
    }
  return out;
}

const isLL = r => r && isFinite(parseFloat(r.lat)) && isFinite(parseFloat(r.lng)) &&
                  !(parseFloat(r.lat) === 0 && parseFloat(r.lng) === 0);
const pickNum = (a, b) => isFinite(parseFloat(a)) ? parseFloat(a) : (isFinite(parseFloat(b)) ? parseFloat(b) : "");

/* ============================================================
   2. 读源
   ============================================================ */

/** 列名 → 标准字段（中日英都能认） */
const FIELD_ALIAS = {
  merchant_id: ["merchant_id", "merchantid", "mchid", "id", "商户号", "商户编号", "商户id", "子商户号"],
  name:        ["name", "名称", "店名", "商户名", "商户名称", "店铺名", "店舗名", "施設名", "title", "store"],
  address:     ["address", "addr", "地址", "住所", "所在地", "addr1"],
  lat:         ["lat", "latitude", "纬度", "緯度", "ido", "y"],
  lng:         ["lng", "lon", "long", "longitude", "经度", "経度", "keido", "x"],
  category:    ["category", "cat", "分类", "分類", "カテゴリ", "カテゴリー", "状态", "状態", "status", "type", "種別"],
  institution: ["institution", "org", "agent", "机构", "機構", "服务商", "服务商名称", "代理"],
  material:    ["material", "物料", "物料类型", "material_type", "铺设物料"],
  week:        ["week", "周次", "週", "週次", "批次", "date", "日期", "更新日"],
  note:        ["note", "remark", "备注", "備考", "comment"]
};
const lowKey = s => String(s || "").trim().toLowerCase().replace(/[\s_\-（）()]/g, "");

function mapHeaders(headers) {
  const m = {};
  headers.forEach((h, i) => {
    const k = lowKey(h);
    for (const key in FIELD_ALIAS) {
      if (m[key] === undefined && FIELD_ALIAS[key].indexOf(k) >= 0) { m[key] = i; break; }
    }
  });
  const findCol = re => { for (let i = 0; i < headers.length; i++) if (re.test(lowKey(headers[i]))) return i; return undefined; };
  if (m.lat === undefined) m.lat = findCol(/^(lat|latitude|纬度|緯度)$/);
  if (m.lng === undefined) m.lng = findCol(/^(lng|lon|long|longitude|经度|経度)$/);
  return m;
}

/** 任意一行对象 → 标准结构（不管源表列名怎么写） */
function toStd(o) {
  const ks = Object.keys(o || {});
  const m = mapHeaders(ks);
  const v = k => {
    const i = m[k];
    if (i === undefined) return "";
    const x = o[ks[i]];
    return (x === null || x === undefined) ? "" : String(x).trim();
  };
  const name = v("name"), address = v("address");
  return {
    merchant_id: v("merchant_id"), name: name, address: address,
    category: v("category"), institution: v("institution"), material: v("material"),
    week: v("week"), note: v("note"),
    lat: parseFloat(v("lat")), lng: parseFloat(v("lng")),
    nameKey: normName(name), addrKey: normAddr(address),
    keyFull: address ? (normName(name) + "|" + normAddr(address)) : "",
    raw: o || {}
  };
}

/** CSV 文本 → 对象数组（自带解析器，GAS / 本地测试行为一致） */
function parseCsvText(text) {
  text = String(text).replace(/^\uFEFF/, "");
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch !== "\r") cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  const grid = rows.filter(r => r.some(c => String(c).trim() !== ""));
  if (!grid.length) return [];
  const head = grid[0].map(h => String(h).trim());
  return grid.slice(1).map(r => { const o = {}; head.forEach((h, i) => o[h] = (r[i] === undefined ? "" : String(r[i]).trim())); return o; });
}

/** Sheet → 对象数组 */
function sheetToObjects(sh) {
  const lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2 || lastC < 1) return [];
  const vals = sh.getRange(1, 1, lastR, lastC).getValues();
  const head = vals[0].map(h => String(h).trim());
  const out = [];
  for (let i = 1; i < vals.length; i++) {
    const o = {}; let any = false;
    head.forEach((h, j) => { const x = vals[i][j]; o[h] = (x === null || x === undefined) ? "" : x; if (String(o[h]).trim() !== "") any = true; });
    if (any) out.push(o);
  }
  return out;
}

/** 源①：踩点数据（优先 Sheet ID，其次公开 CSV） */
function readSpotRows() {
  const p = P();
  const id = p.getProperty("SPOT_SHEET_ID");
  if (id) {
    const ss = SpreadsheetApp.openById(id);
    const nm = p.getProperty("SPOT_SHEET_NAME");
    const sh = nm ? ss.getSheetByName(nm) : (ss.getSheets ? ss.getSheets()[0] : null);
    if (sh) return { rows: sheetToObjects(sh).map(toStd), via: "sheet" };
  }
  const url = p.getProperty("SPOT_CSV_URL");
  if (url) {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200)
      return { rows: parseCsvText(resp.getContentText("UTF-8")).map(toStd), via: "csv" };
  }
  return { rows: [], via: "none" };
}

/** 源②：Knot 存档（「明细」Sheet，同 merchant_id 取最新周） */
function readKnotRows() {
  return readAll().map(toStd);
}

/* ============================================================
   3. 匹配 + 合并（本层的核心）
   ============================================================ */

/**
 * 三级匹配，按可靠性递减：
 *   L1 id    ：merchant_id 精确相等（最可靠）
 *   L2 exact ：店名 + 地址 归一化后完全相等
 *   L3 name  ：只有店名相等（某一边地址缺失时）
 *   L4 geo   ：坐标 50m 内 且 店名相似度 ≥ 0.5（最低可靠，会进「待人工校对」）
 */
function matchAndMerge(spotRows, knotRows) {
  const S = (spotRows || []).slice(), K = (knotRows || []).slice();
  const radius = parseFloat(P().getProperty("GEO_RADIUS")) || 50;

  const usedK = new Array(K.length);
  for (let i = 0; i < K.length; i++) usedK[i] = false;

  const byIdK = {}, byKeyK = {}, byNameK = {};
  K.forEach((r, i) => {
    if (r.merchant_id) (byIdK[r.merchant_id] = byIdK[r.merchant_id] || []).push(i);
    if (r.keyFull)     (byKeyK[r.keyFull]     = byKeyK[r.keyFull]     || []).push(i);
    if (r.nameKey)     (byNameK[r.nameKey]    = byNameK[r.nameKey]    || []).push(i);
  });
  const take = bucket => {
    if (!bucket) return -1;
    for (let i = 0; i < bucket.length; i++) if (!usedK[bucket[i]]) return bucket[i];
    return -1;
  };

  const stats = { id: 0, exact: 0, name: 0, geo: 0, none: 0, both: 0, spotOnly: 0, knotOnly: 0 };
  const pairs = [];

  // L4 用网格索引，避免全表两两比较（数万点时必须）
  const cellDeg = radius / CELL_M_PER_DEG;
  const geoIdx = buildGeoIndex(K, cellDeg);

  S.forEach((s, si) => {
    let ki = -1, level = "none", score = 0;

    if (s.merchant_id) { const c = take(byIdK[s.merchant_id]); if (c >= 0) { ki = c; level = "id"; score = 1; } }
    if (ki < 0 && s.keyFull) { const c = take(byKeyK[s.keyFull]); if (c >= 0) { ki = c; level = "exact"; score = 1; } }
    if (ki < 0 && s.nameKey) {
      const b = byNameK[s.nameKey] || [];
      for (let i = 0; i < b.length; i++) if (!usedK[b[i]]) { ki = b[i]; level = "name"; score = 0.9; break; }
    }
    if (ki < 0 && isLL(s)) {
      let best = -1, bestS = 0;
      const cand = nearbyCells(geoIdx, s.lat, s.lng, cellDeg);
      for (let i = 0; i < cand.length; i++) {
        const ci = cand[i];
        if (usedK[ci] || !isLL(K[ci])) continue;
        const d = haversine(s.lat, s.lng, K[ci].lat, K[ci].lng);
        if (d > radius) continue;
        const nm = sim(s.nameKey, K[ci].nameKey);
        if (nm < 0.5) continue;
        const sc = nm * (1 - 0.3 * (d / radius));      // 距离越远扣分越多
        if (sc > bestS) { bestS = sc; best = ci; }
      }
      if (best >= 0 && bestS >= 0.5) { ki = best; level = "geo"; score = bestS; }
    }

    if (ki >= 0) { usedK[ki] = true; stats[level]++; stats.both++; pairs.push({ s: si, k: ki, level: level, score: score }); }
    else { stats.none++; stats.spotOnly++; pairs.push({ s: si, k: null, level: "none", score: 0 }); }
  });

  K.forEach((k, ci) => { if (!usedK[ci]) { stats.knotOnly++; pairs.push({ s: null, k: ci, level: "none", score: 0 }); } });

  const rows = pairs.map(p => mergeOne(S[p.s], K[p.k], p));
  return { rows: rows, stats: stats };
}

/** 一对（或单边）→ 一条地图记录 */
function mergeOne(s, k, p) {
  const a = s || {}, b = k || {};
  const mergedRaw = Object.assign({}, a.raw || {}, b.raw || {});
  return {
    merchant_id:   a.merchant_id || b.merchant_id || "",
    name:          a.name || b.name || "(名称なし)",
    address:       a.address || b.address || "",
    lat:           pickNum(a.lat, b.lat),
    lng:           pickNum(a.lng, b.lng),
    category:      b.category || a.category || "未分類",
    spot_category: a.category || "",
    knot_category: b.category || "",
    institution:   b.institution || a.institution || "",
    material:      b.material || a.material || "",
    week:          b.week || a.week || "",
    note:          [a.note, b.note].filter(x => x).join(" / "),
    in_spot:       s ? 1 : 0,
    in_knot:       k ? 1 : 0,
    match_status:  (s && k) ? "both" : (s ? "spot-only" : "knot-only"),
    match_level:   p.level,
    match_score:   Math.round(p.score * 100) / 100,
    geocoded:      0,
    prefecture:    "",
    incentive:     "",
    area:          "",
    _raw:          mergedRaw
  };
}

/* ============================================================
   4. 坐标补全 + 区域打标
   ============================================================ */

/** 缺坐标的行：用地址反查（GAS 内置 Maps 服务优先，其次 Geocoding API） */
function geocodeMissing(rows, limit) {
  if (String(P().getProperty("GEOCODE_ENABLED")) === "0") return { tried: 0, ok: 0, failed: [] };
  limit = limit || 200;                       // 单次最多补 200 条，避免撞配额
  let tried = 0, ok = 0; const failed = [];
  for (let i = 0; i < rows.length && tried < limit; i++) {
    const r = rows[i];
    if (isLL(r) || !r.address) continue;
    tried++;
    const g = geocodeOne(r.address);
    if (g) { r.lat = g.lat; r.lng = g.lng; r.geocoded = 1; ok++; }
    else failed.push({ name: r.name, address: r.address, match_status: r.match_status });
  }
  return { tried: tried, ok: ok, failed: failed };
}

function geocodeOne(address) {
  const key = P().getProperty("GEOCODE_KEY");
  // ① GAS 内置 Maps 服务（不用 key，但有每日配额）
  if (typeof Maps !== "undefined" && Maps.newGeocoder) {
    try {
      const res = Maps.newGeocoder().setLanguage("ja").geocode(address);
      if (res && res.status === "OK" && res.results && res.results.length)
        return { lat: res.results[0].latitude, lng: res.results[0].longitude };
    } catch (e) {}
  }
  // ② Geocoding API（需要 key）
  if (key) {
    try {
      const url = "https://maps.googleapis.com/maps/api/geocode/json?language=ja&address=" +
                  encodeURIComponent(address) + "&key=" + key;
      const j = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
      if (j.status === "OK" && j.results && j.results.length)
        return { lat: j.results[0].geometry.location.lat, lng: j.results[0].geometry.location.lng };
    } catch (e) {}
  }
  return null;
}

/** 都道府県抽出 + 激励区域 + 商圈打标 */
const PREF_RE = /^(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/;
function tagArea(rows) {
  let inc = [];
  try { inc = (P().getProperty("INCENTIVE_AREAS") || "").split(/[,，、]/).map(s => s.trim()).filter(Boolean); } catch (e) {}
  let rules = {};
  try { rules = JSON.parse(P().getProperty("AREA_RULES") || "{}"); } catch (e) { rules = {}; }

  rows.forEach(r => {
    const t = nfkc(r.address || "") + " " + nfkc(r.name || "");
    const m = PREF_RE.exec(nfkc(r.address || ""));
    r.prefecture = m ? m[1] : "";
    r.incentive = (r.prefecture && inc.indexOf(r.prefecture) >= 0) ? "激励対象" : (inc.length ? "対象外" : "");
    r.area = "";
    for (const a in rules) {
      const kws = rules[a] || [];
      for (let i = 0; i < kws.length; i++) { if (t.indexOf(nfkc(kws[i])) >= 0) { r.area = a; break; } }
      if (r.area) break;
    }
  });
  return rows;
}

/* ============================================================
   5. 输出：写 Sheet / 供前端读
   ============================================================ */

const MERGED_COLS = ["merchant_id", "name", "category", "spot_category", "knot_category",
  "institution", "material", "address", "lat", "lng", "week",
  "in_spot", "in_knot", "match_status", "match_level", "match_score",
  "prefecture", "incentive", "area", "geocoded", "note"];

/** 把两边原始表里多出来的列也带出去（气泡里才看得到踩点表的全部字段） */
function extraColsOf(rows) {
  const seen = {}, out = [];
  rows.forEach(r => {
    const raw = r._raw || {};
    Object.keys(raw).forEach(k => {
      if (MERGED_COLS.indexOf(lowKey(k)) >= 0) return;
      if (seen[k]) return;
      seen[k] = 1; out.push(k);
    });
  });
  return out.slice(0, 20);
}

function writeSheet(name, cols, rows) {
  const ss = SpreadsheetApp.openById(P().getProperty("SHEET_ID"));
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  else sh.clear();
  const toRow = r => cols.map(c => (r[c] === undefined || r[c] === null ? "" : r[c]));

  // 数万行一次 setValues 会撞 GAS 的 6 分钟上限，所以每 5000 行分批写
  const CHUNK = 5000;
  sh.getRange(1, 1, 1, cols.length).setValues([cols.slice()]);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map(toRow);
    sh.getRange(i + 2, 1, part.length, cols.length).setValues(part);
  }
  return rows.length;
}

/**
 * 主入口：读两个源 → 匹配 → 补坐标 → 打标 → 写「合并」+「待人工校对」
 * 返回统计，方便在 doPost / 日志里看
 */
function buildMerged(opt) {
  opt = opt || {};
  const spot = readSpotRows();                 // {rows, via}  踩点
  const knot = readKnotRows();                 // []           Knot 存档
  const m = matchAndMerge(spot.rows, knot);
  const rows = m.rows;

  tagArea(rows);
  const geo = opt.geocode === false ? { tried: 0, ok: 0, failed: [] } : geocodeMissing(rows);

  // 输出列 = 固定列 + 两边原始表多出来的列
  const extra = extraColsOf(rows);
  const cols = MERGED_COLS.concat(extra);
  rows.forEach(r => extra.forEach(k => { if (r[k] === undefined) r[k] = (r._raw || {})[k] || ""; }));

  // 只有有坐标的点才上图
  const plottable = rows.filter(isLL);
  writeSheet("合并", cols, plottable);

  // 低置信度 or 没坐标的 → 人工校对清单
  const review = rows.filter(r => !isLL(r) || (r.match_level === "geo") || (r.match_level === "name" && r.match_score < 0.9))
                     .map(r => ({
                       name: r.name, address: r.address, match_status: r.match_status,
                       match_level: r.match_level, match_score: r.match_score,
                       lat: r.lat, lng: r.lng, note: r.note, why: !isLL(r) ? "座標なし" : "突合が低信頼"
                     }));
  if (review.length) writeSheet("待人工校对", ["name", "address", "match_status", "match_level", "match_score", "lat", "lng", "why", "note"], review);

  return {
    spot: spot.rows.length, knot: knot.length, via: spot.via,
    merged: rows.length, plottable: plottable.length, review: review.length,
    match: m.stats, geocode: { tried: geo.tried, ok: geo.ok, failed: geo.failed.length }
  };
}

/** 「合并」Sheet → 数组（前端/导出用） */
function readMerged() {
  const ss = SpreadsheetApp.openById(P().getProperty("SHEET_ID"));
  const sh = ss.getSheetByName("合并");
  if (!sh || sh.getLastRow() < 2) return [];
  return sheetToObjects(sh);
}
