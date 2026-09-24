#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pipeline.py — 数据处理层（gas/Pipeline.gs 的 Python 移植）

链路：踩点（CSV URL / 本地文件）+ Knot（JSON）→ 归一化 → 四级匹配 → 合并 → 打标 → 输出

与 GAS 版的区别（合规改造）：
  * 不依赖 Google Apps Script / Google Sheets，纯标准库，可跑在 GitHub Actions
  * 坐标补全默认关闭：不再调用 Google Geocoding，地址字符串不会外发
    缺坐标的行原样保留，并进「待人工校对」清单由业务补

用法：
    python3 tools/pipeline.py --spot-csv <URL或路径> --knot-json <路径> --out-dir data
    python3 tools/pipeline.py --spot-csv spot.csv            # 只有踩点，也能出图
    python3 tools/pipeline.py --spot-csv spot.csv --incentive-areas "東京都,大阪府,北海道"
                              --area-rules '{"心斋桥":["心斎橋","道頓堀"]}'
"""
import argparse
import csv
import io
import json
import math
import os
import re
import sys
import unicodedata
import urllib.request

# ---------------------------------------------------------------- 1. 通用工具

def nfkc(s):
    s = "" if s is None else str(s)
    try:
        return unicodedata.normalize("NFKC", s)
    except Exception:
        return s

CORP_RE = re.compile(
    r"^(株式会社|有限会社|合同会社|合資会社|\(株\)|（株）|\(有\)|（有）|㈱|㈲|㈴|"
    r"Co\.,?\s*Ltd\.?|Ltd\.?|Inc\.?|Corp\.?|K\.K\.)", re.I)

BRACKET_RE = re.compile(r"[（）()\[\]【】〔〕]")
SPACE_RE = re.compile(r"[\s\u3000]+")
HYPHEN_RE = re.compile(r"[\u2010-\u2015\u2212\u2013\u2014\u30fc]")   # ‐-― − – — ー
PUNC_RE = re.compile(r"[・･.,、，]")


def norm_name(s):
    """店名归一化：去法人前缀 / 括号 / 空白 / 句读，只留可比的骨架"""
    t = nfkc(s).strip()
    t = CORP_RE.sub("", t)
    t = BRACKET_RE.sub("", t)
    t = SPACE_RE.sub("", t)
    t = HYPHEN_RE.sub("-", t)
    t = PUNC_RE.sub("", t)
    return t.lower()


ZIP_RE = re.compile(r"^\u3012?\s?\d{3}-?\d{4}\s*")
COUNTRY_RE = re.compile(r"^(日本|Japan|Nihon)\s*", re.I)
CHOME_RE = re.compile(r"(\d+)\s*丁目")
BAN_RE = re.compile(r"(\d+)\s*番(地?の?)?")
GO_RE = re.compile(r"(\d+)\s*号")


def norm_addr(s):
    """地址归一化（v2 规则：NFKC / 去前缀 / 反推 / 多解不改）"""
    t = nfkc(s).strip()
    t = ZIP_RE.sub("", t)
    t = COUNTRY_RE.sub("", t)
    t = SPACE_RE.sub("", t)
    t = CHOME_RE.sub(r"\1-", t)          # 1丁目 → 1-
    t = BAN_RE.sub(r"\1-", t)            # 2番  → 2-
    t = GO_RE.sub(r"\1", t)              # 3号  → 3（接在上一个 - 后）
    t = re.sub(r"-+", "-", t).strip("-")
    t = re.sub(r"[・･]", "", t)
    return t.lower()


def key_of(n, a):
    nn, na = norm_name(n), norm_addr(a)
    return (nn + "|" + na) if na else nn


def _bigrams(s):
    return [s[i:i + 2] for i in range(len(s) - 1)]


def sim(a, b):
    """bigram Dice 系数 + 包含加成（与 Pipeline.gs 完全一致）"""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    A, B = _bigrams(a), _bigrams(b)
    setB = set(B)
    setA = set(A)
    inter = len(setA & setB)
    dice = (2.0 * inter) / (len(setA) + len(setB)) if (setA or setB) else 0.0
    sh, lo = (a, b) if len(a) <= len(b) else (b, a)
    if len(sh) >= 3 and sh in lo:
        cover = len(sh) / len(lo)
        if cover >= 0.25:
            return max(dice, 0.55 + 0.45 * cover)
    return dice


def haversine(lat1, lng1, lat2, lng2):
    """两点距离（米）"""
    R, r = 6371000.0, math.pi / 180
    dlat, dlng = (lat2 - lat1) * r, (lng2 - lng1) * r
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin(dlng / 2) ** 2)
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


CELL_M_PER_DEG = 70000.0


def _cell(lat, lng, cell_deg):
    return (int(math.floor(lat / cell_deg)), int(math.floor(lng / cell_deg)))


def build_geo_index(rows, cell_deg):
    g = {}
    for i, r in enumerate(rows):
        if not is_ll(r):
            continue
        g.setdefault(_cell(r["lat"], r["lng"], cell_deg), []).append(i)
    return g


def nearby_cells(idx, lat, lng, cell_deg):
    cy, cx = _cell(lat, lng, cell_deg)
    out = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out.extend(idx.get((cy + dy, cx + dx), []))
    return out


def _num(x):
    try:
        v = float(str(x).strip())
        return v if math.isfinite(v) else None
    except Exception:
        return None


def is_ll(r):
    if not r:
        return False
    lat, lng = _num(r.get("lat")), _num(r.get("lng"))
    if lat is None or lng is None:
        return False
    return not (lat == 0 and lng == 0)


def pick_num(a, b):
    x = _num(a)
    if x is not None:
        return x
    y = _num(b)
    return y if y is not None else ""


# ---------------------------------------------------------------- 2. 读源

FIELD_ALIAS = {
    "merchant_id": ["merchant_id", "merchantid", "mchid", "id", "商户号", "商户编号",
                    "商户id", "子商户号"],
    "name":        ["name", "名称", "店名", "商户名", "商户名称", "店铺名", "店舗名",
                    "施設名", "title", "store", "shopname", "shop_name", "store_name"],
    "address":     ["address", "addr", "地址", "住所", "所在地", "addr1"],
    "lat":         ["lat", "latitude", "纬度", "緯度", "ido", "y"],
    "lng":         ["lng", "lon", "long", "longitude", "经度", "経度", "keido", "x"],
    "category":    ["category", "cat", "分类", "分類", "カテゴリ", "カテゴリー", "状态",
                    "状態", "status", "type", "種別", "industry", "業種"],
    "institution": ["institution", "org", "agent", "机构", "機構", "服务商", "服务商名称", "代理"],
    "material":    ["material", "物料", "物料类型", "material_type", "铺设物料"],
    "week":        ["week", "周次", "週", "週次", "批次", "date", "日期", "更新日"],
    "note":        ["note", "remark", "备注", "備考", "comment"],
}


def low_key(s):
    return re.sub(r"[\s_\-（）()]", "", str(s or "").strip().lower())


def map_headers(headers):
    m = {}
    for i, h in enumerate(headers):
        k = low_key(h)
        for key, aliases in FIELD_ALIAS.items():
            if m.get(key) is None and k in aliases:
                m[key] = i
                break
    def find(pat):
        for i, h in enumerate(headers):
            if re.match(pat, low_key(h)):
                return i
        return None
    if m.get("lat") is None:
        m["lat"] = find(r"^(lat|latitude|纬度|緯度)$")
    if m.get("lng") is None:
        m["lng"] = find(r"^(lng|lon|long|longitude|经度|経度)$")
    return m


# 合并坐标列的常见名（踩点表就是 "LatLng" = "34.665192, 135.501779"，必须拆开取）
LATLNG_KEYS = {"latlng", "latlong", "lnglat", "座標", "座標値", "coordinates",
               "coordinate", "location", "geo", "geopoint"}


def split_latlng(val):
    """'34.665192, 135.501779' → (34.665192, 135.501779)；拆不出来返回 (None, None)"""
    parts = [p for p in re.split(r"[,\s/]+", str(val or "").strip()) if p]
    nums = [p for p in parts if _num(p) is not None]
    if len(nums) >= 2:
        return _num(nums[0]), _num(nums[1])
    return None, None


def to_std(o):
    """任意一行对象 → 标准结构（不管源表列名怎么写）"""
    ks = list((o or {}).keys())
    m = map_headers(ks)

    def v(k):
        i = m.get(k)
        if i is None:
            return ""
        x = o.get(ks[i])
        return "" if x is None else str(x).strip()

    name, address = v("name"), v("address")
    lat, lng = _num(v("lat")), _num(v("lng"))
    if lat is None or lng is None:
        for k in ks:
            if low_key(k) in LATLNG_KEYS:
                la, ln = split_latlng(o.get(k))
                if la is not None and ln is not None:
                    lat = la if lat is None else lat
                    lng = ln if lng is None else lng
                    break
    return {
        "merchant_id": v("merchant_id"), "name": name, "address": address,
        "category": v("category"), "institution": v("institution"), "material": v("material"),
        "week": v("week"), "note": v("note"),
        "lat": lat, "lng": lng,
        "name_key": norm_name(name), "addr_key": norm_addr(address),
        "key_full": (norm_name(name) + "|" + norm_addr(address)) if address else "",
        "raw": o or {},
    }


def parse_csv_text(text):
    """自带 CSV 解析器，与 GAS 版行为一致（支持引号内逗号/换行）"""
    text = str(text).lstrip("\ufeff")
    rows, row, cur, q = [], [], "", False
    i = 0
    while i < len(text):
        ch = text[i]
        if q:
            if ch == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    cur += '"'
                    i += 1
                else:
                    q = False
            else:
                cur += ch
        else:
            if ch == '"':
                q = True
            elif ch == ",":
                row.append(cur); cur = ""
            elif ch == "\n":
                row.append(cur); rows.append(row); row = []; cur = ""
            elif ch != "\r":
                cur += ch
        i += 1
    if cur != "" or row:
        row.append(cur); rows.append(row)
    grid = [r for r in rows if any(str(c).strip() != "" for c in r)]
    if not grid:
        return []
    head = [str(h).strip() for h in grid[0]]
    out = []
    for r in grid[1:]:
        o = {}
        for j, h in enumerate(head):
            o[h] = str(r[j]).strip() if j < len(r) and r[j] is not None else ""
        out.append(o)
    return out


def _fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "knot-map-pipeline/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def read_rows_from_source(src):
    """src 可以是 http(s) URL 或本地路径；返回 (行对象数组, 来源说明)"""
    if not src:
        return [], "none"
    try:
        if src.startswith("http://") or src.startswith("https://"):
            text = _fetch(src)
            via = "url"
        else:
            with open(src, "r", encoding="utf-8-sig") as f:
                text = f.read()
            via = "file"
    except Exception as e:
        print(f"WARN: 读取源失败 {src}: {e}", file=sys.stderr)
        return [], "error"
    if src.lower().endswith(".json") or text.lstrip().startswith(("{", "[")):
        try:
            j = json.loads(text)
            arr = j if isinstance(j, list) else (j.get("rows") or j.get("data") or j.get("items") or [])
            return arr, via + ":json"
        except Exception as e:
            print(f"WARN: JSON 解析失败 {src}: {e}", file=sys.stderr)
            return [], via + ":json-error"
    return parse_csv_text(text), via + ":csv"


# ---------------------------------------------------------------- 3. 匹配 + 合并

def match_and_merge(spot_rows, knot_rows, radius=50.0):
    """四级匹配：L1 id → L2 店名+地址 → L3 仅店名 → L4 坐标 50m 内且店名相似 ≥0.5"""
    S = [to_std(r) for r in (spot_rows or [])]
    K = [to_std(r) for r in (knot_rows or [])]
    used_k = [False] * len(K)

    by_id, by_key, by_name = {}, {}, {}
    for i, r in enumerate(K):
        if r["merchant_id"]:
            by_id.setdefault(r["merchant_id"], []).append(i)
        if r["key_full"]:
            by_key.setdefault(r["key_full"], []).append(i)
        if r["name_key"]:
            by_name.setdefault(r["name_key"], []).append(i)

    def take(bucket):
        if not bucket:
            return -1
        for i in bucket:
            if not used_k[i]:
                return i
        return -1

    stats = {"id": 0, "exact": 0, "name": 0, "geo": 0, "none": 0,
             "both": 0, "spot_only": 0, "knot_only": 0}
    pairs = []

    cell_deg = radius / CELL_M_PER_DEG
    geo_idx = build_geo_index(K, cell_deg)

    for si, s in enumerate(S):
        ki, level, score = -1, "none", 0.0
        if s["merchant_id"]:
            c = take(by_id.get(s["merchant_id"]))
            if c >= 0:
                ki, level, score = c, "id", 1.0
        if ki < 0 and s["key_full"]:
            c = take(by_key.get(s["key_full"]))
            if c >= 0:
                ki, level, score = c, "exact", 1.0
        if ki < 0 and s["name_key"]:
            for c in by_name.get(s["name_key"], []):
                if not used_k[c]:
                    ki, level, score = c, "name", 0.9
                    break
        if ki < 0 and is_ll(s):
            best, best_s = -1, 0.0
            for ci in nearby_cells(geo_idx, s["lat"], s["lng"], cell_deg):
                if used_k[ci] or not is_ll(K[ci]):
                    continue
                d = haversine(s["lat"], s["lng"], K[ci]["lat"], K[ci]["lng"])
                if d > radius:
                    continue
                nm = sim(s["name_key"], K[ci]["name_key"])
                if nm < 0.5:
                    continue
                sc = nm * (1 - 0.3 * (d / radius))
                if sc > best_s:
                    best_s, best = sc, ci
            if best >= 0 and best_s >= 0.5:
                ki, level, score = best, "geo", best_s

        if ki >= 0:
            used_k[ki] = True
            stats[level] += 1
            stats["both"] += 1
            pairs.append((si, ki, level, score))
        else:
            stats["none"] += 1
            stats["spot_only"] += 1
            pairs.append((si, None, "none", 0.0))

    for ci in range(len(K)):
        if not used_k[ci]:
            stats["knot_only"] += 1
            pairs.append((None, ci, "none", 0.0))

    rows = [merge_one(S[p[0]] if p[0] is not None else None,
                      K[p[1]] if p[1] is not None else None, p) for p in pairs]
    return rows, stats


def merge_one(s, k, p):
    a, b = s or {}, k or {}
    merged_raw = dict(a.get("raw") or {})
    merged_raw.update(b.get("raw") or {})
    return {
        "merchant_id":   a.get("merchant_id") or b.get("merchant_id") or "",
        "name":          a.get("name") or b.get("name") or "(名称なし)",
        "address":       a.get("address") or b.get("address") or "",
        "lat":           pick_num(a.get("lat"), b.get("lat")),
        "lng":           pick_num(a.get("lng"), b.get("lng")),
        "category":      b.get("category") or a.get("category") or "未分類",
        "spot_category": a.get("category") or "",
        "knot_category": b.get("category") or "",
        "institution":   b.get("institution") or a.get("institution") or "",
        "material":      b.get("material") or a.get("material") or "",
        "week":          b.get("week") or a.get("week") or "",
        "note":          " / ".join([x for x in (a.get("note"), b.get("note")) if x]),
        "in_spot":       1 if s else 0,
        "in_knot":       1 if k else 0,
        "match_status":  ("both" if (s and k) else ("spot-only" if s else "knot-only")),
        "match_level":   p[2],
        "match_score":   round(p[3] * 100) / 100,
        "prefecture":    "",
        "incentive":     "",
        "area":          "",
        "_raw":          merged_raw,
    }


# ---------------------------------------------------------------- 4. 区域打标

PREF_RE = re.compile(
    r"^(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|"
    r"東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|"
    r"滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|"
    r"香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)")


def tag_area(rows, incentive_areas=None, area_rules=None):
    inc = [s.strip() for s in re.split(r"[,，、]", incentive_areas or "") if s.strip()]
    rules = area_rules or {}
    for r in rows:
        raw = r.get("_raw") or {}
        t = nfkc(r.get("address") or "") + " " + nfkc(r.get("name") or "")
        m = PREF_RE.match(nfkc(r.get("address") or ""))
        # 地址里正则没命中时，回退用源表自带的 Prefecture 列（踩点表就有）
        r["prefecture"] = m.group(1) if m else str(_raw_get(raw, "prefecture") or "").strip()
        r["incentive"] = ("激励対象" if (r["prefecture"] and r["prefecture"] in inc)
                          else ("対象外" if inc else ""))
        r["area"] = ""
        for a, kws in rules.items():
            for kw in kws or []:
                if nfkc(kw) in t:
                    r["area"] = a
                    break
            if r["area"]:
                break
        # 商圈：规则没命中就沿用源表自带的 Area / District（踩点表自带，不能丢）
        if not r["area"]:
            r["area"] = (str(_raw_get(raw, "area") or "").strip() or
                         str(_raw_get(raw, "district") or "").strip())
    return rows


def _raw_get(raw, std_key):
    """在原始行里按标准字段的别名找一个非空值（大小写/下划线不敏感）"""
    aliases = FIELD_ALIAS.get(std_key, [std_key])
    for k, v in (raw or {}).items():
        if low_key(k) in {low_key(a) for a in aliases}:
            s = "" if v is None else str(v).strip()
            if s:
                return s
    return ""


# ---------------------------------------------------------------- 5. 输出

MERGED_COLS = ["merchant_id", "name", "category", "spot_category", "knot_category",
               "institution", "material", "address", "lat", "lng", "week",
               "in_spot", "in_knot", "match_status", "match_level", "match_score",
               "prefecture", "incentive", "area", "note"]


def extra_cols(rows, limit=20, min_fill=0.05):
    """源表里多出来的列：只保留有一定填充率的（全空的列带出去只会让 JSON 变大）"""
    std = {low_key(c) for c in MERGED_COLS}
    order, fill = [], {}
    for r in rows:
        for k, v in (r.get("_raw") or {}).items():
            if low_key(k) in std:
                continue
            if k not in fill:
                fill[k] = 0
                order.append(k)
            if v is not None and str(v).strip() != "":
                fill[k] += 1
    n = max(1, len(rows))
    keep = [k for k in order if fill.get(k, 0) / n >= min_fill]
    return keep[:limit]


def build_merged(spot_src=None, knot_src=None, radius=50.0,
                 incentive_areas=None, area_rules=None):
    spot_rows, spot_via = read_rows_from_source(spot_src)
    knot_rows, knot_via = read_rows_from_source(knot_src)
    rows, stats = match_and_merge(spot_rows, knot_rows, radius=radius)
    tag_area(rows, incentive_areas, area_rules)

    extra = extra_cols(rows)
    cols = MERGED_COLS + extra
    for r in rows:
        for k in extra:
            if r.get(k) is None:
                r[k] = (r.get("_raw") or {}).get(k, "")

    plottable = [r for r in rows if is_ll(r)]
    review = [{
        "name": r["name"], "address": r["address"], "match_status": r["match_status"],
        "match_level": r["match_level"], "match_score": r["match_score"],
        "lat": r["lat"], "lng": r["lng"], "note": r["note"],
        "why": "座標なし" if not is_ll(r) else "突合が低信頼",
    } for r in rows if (not is_ll(r)) or r["match_level"] == "geo"
              or (r["match_level"] == "name" and r["match_score"] < 0.9)]

    return {
        "rows": plottable, "review": review, "cols": cols, "all_rows": rows,
        "stats": {
            "spot": len(spot_rows), "knot": len(knot_rows),
            "spot_via": spot_via, "knot_via": knot_via,
            "merged": len(rows), "plottable": len(plottable), "review": len(review),
            "match": stats,
            "no_coord": len(rows) - len(plottable),
        },
    }


def write_outputs(res, out_dir="data"):
    os.makedirs(out_dir, exist_ok=True)
    rows, cols = res["rows"], res["cols"]
    stats = res["stats"]

    # 只输出目标列（_raw 含源表全部原始列，带出去会让 JSON 胀到数 MB）
    slim = [{c: ("" if r.get(c) is None else r.get(c)) for c in cols} for r in rows]

    payload = {
        "ok": True,
        "updated": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat(timespec="seconds"),
        "total": len(slim),
        "stats": stats,
        "rows": slim,
    }
    p_json = os.path.join(out_dir, "merged.json")
    with open(p_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    p_csv = os.path.join(out_dir, "merged.csv")
    with open(p_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in cols})

    p_rev = os.path.join(out_dir, "review.json")
    with open(p_rev, "w", encoding="utf-8") as f:
        json.dump({"ok": True, "total": len(res["review"]), "rows": res["review"]},
                  f, ensure_ascii=False)
    return p_json, p_csv, p_rev


def main():
    ap = argparse.ArgumentParser(description="踩点 + Knot → 地图数据（去 Google 版）")
    ap.add_argument("--spot-csv", default=os.environ.get("SPOT_CSV_URL", ""),
                    help="踩点数据：CSV 的 http(s) URL 或本地路径")
    ap.add_argument("--knot-json", default=os.environ.get("KNOT_JSON", ""),
                    help="Knot 数据：JSON 的路径或 URL（可省）")
    ap.add_argument("--out-dir", default="data")
    ap.add_argument("--radius", type=float, default=50.0, help="坐标就近匹配半径（米）")
    ap.add_argument("--incentive-areas", default=os.environ.get("INCENTIVE_AREAS", ""),
                    help="激励区域，逗号分隔，例：東京都,大阪府,北海道")
    ap.add_argument("--area-rules", default=os.environ.get("AREA_RULES", ""),
                    help='商圈规则 JSON，例：{"心斋桥":["心斎橋","道頓堀"]}')
    a = ap.parse_args()

    rules = {}
    if a.area_rules:
        try:
            rules = json.loads(a.area_rules)
        except Exception as e:
            print(f"WARN: AREA_RULES 不是合法 JSON，忽略：{e}", file=sys.stderr)

    if not a.spot_csv and not a.knot_json:
        print("ERROR: --spot-csv 与 --knot-json 至少给一个", file=sys.stderr)
        sys.exit(2)

    res = build_merged(a.spot_csv, a.knot_json, radius=a.radius,
                       incentive_areas=a.incentive_areas, area_rules=rules)
    p_json, p_csv, p_rev = write_outputs(res, a.out_dir)

    s = res["stats"]
    print(json.dumps({
        "spot": s["spot"], "spot_via": s["spot_via"],
        "knot": s["knot"], "knot_via": s["knot_via"],
        "merged": s["merged"], "plottable": s["plottable"],
        "no_coord": s["no_coord"], "review": s["review"],
        "match": s["match"],
        "out": [p_json, p_csv, p_rev],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
