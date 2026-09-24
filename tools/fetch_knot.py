#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_knot.py — 直连 Knot AGUI API 拉取每周跑数结果，输出 data/knot.json

用途：替代旧链路里的「Knot → curl POST → Google Apps Script」。
数据全程不经过 Google：Knot → 本脚本 → 本地 JSON → pipeline.py → 静态文件。

环境变量：
  KNOT_API_URL     必填，AGUI 端点：https://knot.woa.com/apigw/api/v1/agents/agui/<agent_id>
  KNOT_AGENT_TOKEN 必填，个人 token 或 agent token（knot_xxx）
  KNOT_USERNAME    可选，填了就是 agent token 模式（会带 X-Username 头）
  KNOT_MODEL       可选，默认 kimi-k2.5

用法：
    python3 tools/fetch_knot.py --out data/knot.json
    python3 tools/fetch_knot.py --prompt-file knot/agent_prompt_weekly.md --out data/knot.json
    python3 tools/fetch_knot.py --skip-if-unconfigured    # 没配 token 时静默跳过（exit 0），供 CI 用

退出码：
  0 成功（或 --skip-if-unconfigured 且未配置）
  2 未配置环境变量且没给 --skip-if-unconfigured
  3 请求/解析失败
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SENTINEL_RE = re.compile(
    r"<<<KNOT_JSON>>>(.*?)<<<END_KNOT_JSON>>>", re.S)
FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.S)


def cfg_from_env():
    return {
        "api_url": os.environ.get("KNOT_API_URL", "").strip(),
        "token": os.environ.get("KNOT_AGENT_TOKEN", "").strip(),
        "username": os.environ.get("KNOT_USERNAME", "").strip(),
        "model": os.environ.get("KNOT_MODEL", "kimi-k2.5").strip(),
    }


def headers_for(cfg):
    if cfg["username"]:
        # Agent Token 模式
        return {"x-knot-token": cfg["token"], "X-Username": cfg["username"],
                "Content-Type": "application/json"}
    # 个人 token 模式
    return {"x-knot-api-token": cfg["token"], "Content-Type": "application/json"}


def post_message(cfg, message, timeout=600):
    body = json.dumps({
        "input": {
            "message": message,
            "conversation_id": "",
            "model": cfg["model"],
            "stream": True,
            "enable_web_search": False,
            "temperature": 0.5,
        }
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(cfg["api_url"], data=body,
                                 headers=headers_for(cfg), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def collect_text(raw):
    """AGUI 可能返回 SSE（data: {...} 行）或普通 JSON。尽力拼出全部文本。"""
    buf = []
    try:
        j = json.loads(raw)
        # 非流式：直接找常见字段
        for k in ("response", "message", "content", "text", "output"):
            v = j.get(k)
            if isinstance(v, str) and v.strip():
                buf.append(v)
        if buf:
            return "\n".join(buf)
    except Exception:
        pass

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if line in ("[DONE]", ""):
            continue
        try:
            ev = json.loads(line)
        except Exception:
            # 不是 JSON 的裸文本也留着，可能就是正文
            buf.append(line)
            continue
        if isinstance(ev, dict):
            for k in ("content", "text", "delta", "message", "response", "value"):
                v = ev.get(k)
                if isinstance(v, str) and v.strip():
                    buf.append(v)
                elif isinstance(v, list):          # content: [{text: ...}]
                    for it in v:
                        if isinstance(it, dict):
                            for k2 in ("text", "content", "value"):
                                if isinstance(it.get(k2), str):
                                    buf.append(it[k2])
    return "\n".join(buf)


def extract_rows(text):
    """从混合正文里截出 rows：优先哨兵块（可多块合并），其次 markdown 围栏 JSON。"""
    blocks = SENTINEL_RE.findall(text)
    rows, meta = [], {}
    for b in blocks:
        try:
            j = json.loads(b.strip())
        except Exception as e:
            print(f"WARN: 哨兵块解析失败：{e}", file=sys.stderr)
            continue
        if isinstance(j, list):
            rows.extend(j)
            continue
        meta = {k: v for k, v in j.items() if k != "rows"} or meta
        r = j.get("rows")
        if isinstance(r, list):
            rows.extend(r)
    if rows:
        return rows, meta, "sentinel"

    for m in FENCE_RE.findall(text):
        try:
            j = json.loads(m)
        except Exception:
            continue
        if isinstance(j, list):
            return j, {}, "fence"
        if isinstance(j, dict) and isinstance(j.get("rows"), list):
            return j["rows"], {k: v for k, v in j.items() if k != "rows"}, "fence"
    return [], {}, "none"


def main():
    ap = argparse.ArgumentParser(description="从 Knot 拉本周跑数结果")
    ap.add_argument("--out", default="data/knot.json")
    ap.add_argument("--prompt-file", default="knot/agent_prompt_weekly.md",
                    help="发给 agent 的 prompt（默认取合规周版）")
    ap.add_argument("--message", default="", help="直接给消息，优先级高于 --prompt-file")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--skip-if-unconfigured", action="store_true",
                    help="未配置环境变量时静默跳过（exit 0），让 CI 继续跑")
    a = ap.parse_args()

    cfg = cfg_from_env()
    if not cfg["api_url"] or not cfg["token"]:
        msg = "KNOT_API_URL / KNOT_AGENT_TOKEN 未配置"
        if a.skip_if_unconfigured:
            print(f"SKIP: {msg}（--skip-if-unconfigured）")
            sys.exit(0)
        print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(2)

    if a.message:
        message = a.message
    else:
        try:
            with open(a.prompt_file, "r", encoding="utf-8") as f:
                message = f.read()
        except Exception as e:
            print(f"ERROR: 读 prompt 失败 {a.prompt_file}: {e}", file=sys.stderr)
            sys.exit(3)

    t0 = time.time()
    try:
        raw = post_message(cfg, message, timeout=a.timeout)
    except urllib.error.HTTPError as e:
        print(f"ERROR: Knot 返回 HTTP {e.code}: {e.read()[:300]!r}", file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f"ERROR: 请求失败: {e}", file=sys.stderr)
        sys.exit(3)

    text = collect_text(raw)
    rows, meta, via = extract_rows(text)

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    payload = {
        "ok": bool(rows),
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "week": meta.get("week", ""),
        "total_rows": meta.get("total_rows", len(rows)),
        "via": via,
        "elapsed_sec": round(time.time() - t0, 1),
        "rows": rows,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    print(json.dumps({"out": a.out, "rows": len(rows), "via": via,
                      "week": payload["week"],
                      "total_rows": payload["total_rows"],
                      "elapsed_sec": payload["elapsed_sec"]}, ensure_ascii=False))
    if not rows:
        print("WARN: 没截到 rows（哨兵块/围栏都没匹配上），已写出空结果", file=sys.stderr)
        sys.exit(3)


if __name__ == "__main__":
    main()
