#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据接入脚本：把业务侧的 Excel / CSV 变成地图页能直接读的 CSV，并先出一份体检报告。

用法：
    python ingest.py <文件>                      # 只读体检，不写文件
    python ingest.py <文件> --out data.csv       # 体检 + 输出标准 CSV
    python ingest.py <文件> --sheet 明细          # 指定 sheet（xlsx 多表时）
    python ingest.py <文件> --geocode nominatim  # 缺坐标的行用 OSM 免费地理编码补（1 req/s，无需 key）
    python ingest.py <文件> --geocode google --key <KEY>   # 用 Google Geocoding 补（精度最高）

体检报告会告诉你：行数、列名、哪些列被识别成 名称/地址/纬度/经度/分类/周次、
缺坐标多少行、分类与周次的分布。识别错了就用 --map 手动指定，例如：
    python ingest.py f.xlsx --map "纬度=緯度" --map "分类=ステータス"
"""
import argparse
import csv
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET

# 和 points.html 前端保持一致的列名别名（中日英）
ALIAS = {
    "name":     ["name", "名称", "店名", "商户名", "商户名称", "店铺名", "店舗名", "施設名", "title"],
    "address":  ["address", "addr", "地址", "住所", "所在地"],
    "lat":      ["lat", "latitude", "纬度", "緯度", "ido"],
    "lng":      ["lng", "lon", "long", "longitude", "经度", "経度", "keido"],
    "category": ["category", "cat", "分类", "分類", "カテゴリ", "カテゴリー",
                 "状态", "状態", "ステータス", "status", "type", "種別"],
    "week":     ["week", "周次", "週", "週次", "批次", "バッチ", "date", "日期", "更新日"],
}
M = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def norm(s):
    return str(s or "").strip().lower().replace(" ", "").replace("_", "").replace("　", "")


def read_xlsx(path, sheet=None):
    """优先 openpyxl，失败则回退到标准库解析（零依赖）"""
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        names = wb.sheetnames
        ws = wb[sheet] if sheet and sheet in names else wb[names[0]]
        rows = [[("" if c is None else str(c).strip()) for c in r] for r in ws.iter_rows(values_only=True)]
        return rows, names
    except ImportError:
        pass
    # ---- 回退：标准库解析 ----
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("{%s}si" % M):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % M)))
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []

    def colnum(c):
        n = 0
        for ch in c:
            n = n * 26 + ord(ch) - 64
        return n

    def colname(i):
        s = ""
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    for row in root.iter("{%s}row" % M):
        vals = {}
        for c in row.findall("{%s}c" % M):
            m = re.match(r"([A-Z]+)", c.get("r") or "")
            if not m:
                continue
            v = c.find("{%s}v" % M)
            val = ""
            if v is not None and v.text is not None:
                val = shared[int(v.text)] if c.get("t") == "s" else v.text
            vals[m.group(1)] = str(val).strip()
        if vals:
            mx = max(colnum(k) for k in vals)
            rows.append([vals.get(colname(i), "") for i in range(1, mx + 1)])
    return rows, ["sheet1"]


def read_table(path, sheet=None):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        return read_xlsx(path, sheet)
    if ext == ".xls":
        print("  [警告] .xls(旧格式) 读不了，请在 Excel 里另存为 .xlsx 或 .csv", file=sys.stderr)
        sys.exit(2)
    # CSV / TSV：自动嗅探分隔符与编码
    for enc in ("utf-8-sig", "utf-8", "cp932", "gb18030"):
        try:
            with open(path, encoding=enc) as f:
                sample = f.read(4096)
            delim = "\t" if sample.count("\t") > sample.count(",") else ","
            with open(path, encoding=enc, newline="") as f:
                return [r for r in csv.reader(f, delimiter=delim)], []
        except UnicodeDecodeError:
            continue
    print("  [错误] 无法识别编码", file=sys.stderr)
    sys.exit(2)


def map_cols(headers, override=None):
    m = {}
    for key, names in ALIAS.items():
        for i, h in enumerate(headers):
            if norm(h) in [norm(n) for n in names]:
                m[key] = i
                break
    # 兜底：包含关键字即可（找不到时 findIndex 语义 -> -1 要转 None）
    if m.get("lat") is None:
        m["lat"] = next((i for i, h in enumerate(headers) if re.search(r"lat|緯度|纬度", norm(h))), None)
    if m.get("lng") is None:
        m["lng"] = next((i for i, h in enumerate(headers) if re.search(r"lng|lon|経度|经度", norm(h))), None)
    for pair in override or []:
        if "=" in pair:
            k, v = pair.split("=", 1)
            k = k.strip()
            if k in ALIAS:
                idx = next((i for i, h in enumerate(headers) if norm(h) == norm(v)), None)
                if idx is None:
                    print(f"  [警告] 找不到列「{v}」，--map {k} 未生效")
                else:
                    m[k] = idx
    return m


def geocode(addr, mode, key=None):
    import urllib.parse
    import urllib.request
    import json
    q = urllib.parse.quote(addr)
    try:
        if mode == "google" and key:
            url = f"https://maps.googleapis.com/maps/api/geocode/json?address={q}&key={key}&region=jp"
            with urllib.request.urlopen(url, timeout=10) as r:
                d = json.load(r)
            if d.get("status") == "OK":
                loc = d["results"][0]["geometry"]["location"]
                return loc["lat"], loc["lng"]
        elif mode == "nominatim":
            url = f"https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=1&countrycodes=jp"
            req = urllib.request.Request(url, headers={"User-Agent": "knot-map-ingest/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                d = json.load(r)
            if d:
                return float(d[0]["lat"]), float(d[0]["lon"])
    except Exception:
        pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("--out", default=None, help="输出标准 CSV 的路径")
    ap.add_argument("--map", action="append", default=[], help='手动指定列，如 --map "纬度=緯度"')
    ap.add_argument("--geocode", choices=["google", "nominatim"], default=None)
    ap.add_argument("--key", default=None, help="Google Geocoding API key（--geocode google 时用）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 行（测试用）")
    a = ap.parse_args()

    print(f"\n=== 读取 {os.path.basename(a.file)} ===")
    rows, sheets = read_table(a.file, a.sheet)
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if not rows:
        print("  [错误] 文件是空的"); sys.exit(2)
    if sheets and len(sheets) > 1:
        print(f"  sheet 列表：{sheets}（当前用：{a.sheet or sheets[0]}）")

    headers = [str(h).strip() for h in rows[0]]
    body = rows[1:]
    if a.limit:
        body = body[:a.limit]
    print(f"  表头({len(headers)} 列)：{' | '.join(headers)}")
    print(f"  数据行：{len(body)}")

    c = map_cols(headers, a.map)
    print("\n=== 列识别结果 ===")
    for k in ["name", "address", "lat", "lng", "category", "week"]:
        i = c.get(k)
        print(f"  {k:<9}: {'（未识别）' if i is None else headers[i]}")

    if c.get("lat") is None or c.get("lng") is None:
        print("\n  [阻断] 找不到纬度/经度列。请先补坐标列，或用 --map 手动指定，或用 --geocode 从地址生成。")
        sys.exit(1)

    def val(r, k):
        i = c.get(k)
        return str(r[i]).strip() if i is not None and i < len(r) else ""

    ok, missing = [], []
    for r in body:
        try:
            lat, lng = float(val(r, "lat")), float(val(r, "lng"))
            if lat and lng and not (lat == 0 and lng == 0):
                ok.append(r); continue
        except ValueError:
            pass
        missing.append(r)
    print(f"\n=== 坐标体检 ===")
    print(f"  有坐标：{len(ok)} 行")
    print(f"  缺坐标：{len(missing)} 行" + ("（不会被打点，页面会显示跳过数）" if missing else ""))
    if missing and not a.geocode:
        print("  → 需要补坐标就加：--geocode nominatim（免费）或 --geocode google --key <KEY>（最准）")

    filled = 0
    if missing and a.geocode:
        print(f"\n=== 地理编码补坐标（{a.geocode}）===")
        for r in missing:
            if not val(r, "address"):
                continue
            g = geocode(val(r, "address"), a.geocode, a.key)
            if g:
                while len(r) <= max(c["lat"], c["lng"]):
                    r.append("")
                r[c["lat"]], r[c["lng"]] = f"{g[0]:.6f}", f"{g[1]:.6f}"
                ok.append(r); filled += 1
            if a.geocode == "nominatim":
                time.sleep(1.1)  # Nominatim 要求 ≤1 req/s
        print(f"  补回 {filled} 行，仍缺 {len(missing) - filled} 行")

    from collections import Counter
    print("\n=== 分类分布 ===")
    if c.get("category") is not None:
        for v, n in Counter(val(r, "category") or "（空）" for r in ok).most_common(12):
            print(f"  {v}: {n}")
    else:
        print("  （无分类列，页面会全部归为「未分類」单色）")
    if c.get("week") is not None:
        print("\n=== 周次分布 ===")
        for v, n in sorted(Counter(val(r, 'week') or '（空）' for r in ok).items()):
            print(f"  {v}: {n}")

    if a.out:
        with open(a.out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(headers)
            w.writerows(ok)
        size = os.path.getsize(a.out) / 1024
        print(f"\n=== 已输出 {a.out} ===")
        print(f"  {len(ok)} 行（补坐标 {filled} 行），{size:.0f} KB")
        print(f"  把 points.html 的 CONFIG.dataUrl 改成 \"{os.path.basename(a.out)}\" 即可")


if __name__ == "__main__":
    main()
