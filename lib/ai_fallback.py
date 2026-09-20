#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Grok 主用 / OpenAI 备用的共用小模块(python 侧)。

背景:grok 走 SuperGrok 周配额,用完后 CLI 退出码 1、正文里是
    API error (status 402 Payment Required): Grok Build usage balance exhausted
这时三条链路的行为(2026-09-20 用户拍板):
  * BTT 新帖速览、名人发币速览、空投雷达 —— 切到 OpenAI 最便宜的一档接着跑;
  * NFT 打新追踪 —— 直接暂停,不走备用(每次联网核查约 5 万 token,等 grok 换号回来)。

对外只有几件事:
    ai_call(grok_fn, prompt, ...)          先 grok、必要时 OpenAI,返回 (text, cost, provider)
    grok_exhausted()                       标记还在冷却期内吗(NFT 用它决定是否跳过本轮)
    note_grok_ok() / note_grok_fail(err)   给不走 ai_call 的调用点手动记账用
    openai_enabled()                       有没有配 OPENAI_API_KEY

状态文件(默认 $HOME,服务器上四个服务的 HOME 都是 /opt/riskdesk,所以天然共享):
    .grok-exhausted        JSON:{"ts":…,"reason":…,"streak":…}  —— 耗尽标记 + 连败计数
    .ai-fallback-cost.json JSON:{"lastDay":…,"days":{"2026-09-20":{...}}}
没有 OPENAI_API_KEY 时备用不启用,行为与加这个模块之前完全一致(只多记一条日志)。
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

CST = timezone(timedelta(hours=8))

# ---------- 配置 ----------
STATE_DIR = os.environ.get("AI_FALLBACK_DIR") or os.path.expanduser("~")
FLAG_PATH = os.path.join(STATE_DIR, ".grok-exhausted")
COST_PATH = os.path.join(STATE_DIR, ".ai-fallback-cost.json")
# 标记多久后再试一次 grok(分钟)。到点后任何一条链路的下一次调用都会拿 grok 探一次路,
# 成功就清标记(NFT 也跟着自动恢复),还是 402 就把标记时间往后推一小时。
RETRY_MIN = float(os.environ.get("AI_GROK_RETRY_MIN", "60"))
# 非 402 的普通失败连着这么多次也算「grok 不可用」,免得网络烂掉时一直干等
FAIL_STREAK = int(os.environ.get("AI_GROK_FAIL_STREAK", "5"))

OPENAI_KEY = (os.environ.get("OPENAI_API_KEY") or "").strip()
OPENAI_BASE = (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
# 09-20 查证:gpt-5-nano 是全线最便宜的一档($0.05 / $0.40 每百万 token),且支持内置 web_search。
# 带搜索时成本大头是搜索本身($10/1000 次),模型档几乎不影响总价;若嫌 nano 检索规划太糙,
# 把 OPENAI_WEB_MODEL 改成 gpt-5.6-luna 即可,不用动代码。
OPENAI_MODEL = (os.environ.get("OPENAI_MODEL") or "gpt-5-nano").strip()
OPENAI_WEB_MODEL = (os.environ.get("OPENAI_WEB_MODEL") or OPENAI_MODEL).strip()
OPENAI_TIMEOUT = int(os.environ.get("OPENAI_TIMEOUT_SEC", "600"))
OPENAI_PROXY = (os.environ.get("OPENAI_PROXY") or os.environ.get("BTT_GROK_PROXY") or "").strip()

# 每百万 token 美元;只用来在日志里给个量级,不做硬上限(用户不喜欢自作主张限额)
PRICES = {
    "gpt-5-nano": (0.05, 0.40),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5": (1.25, 10.00),
    "gpt-5.6-luna": (0.20, 1.20),
    "gpt-5.4-nano": (0.20, 1.25),
}
# 内置 web_search 按次计费($10 / 1000 次),同样只用于估算
WEB_SEARCH_CALL_USD = float(os.environ.get("OPENAI_WEB_SEARCH_USD", "0.01"))

EXHAUSTED_RE = re.compile(
    r"(usage balance exhausted|balance exhausted|status\s*402|402 payment required"
    r"|\"http_status\"\s*:\s*402|insufficient (?:credit|balance|quota)|quota exceeded)",
    re.I,
)


def _log(msg):
    print("[ai] " + str(msg), flush=True)


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else default
    except Exception:
        return default


def _write_json(path, obj):
    """原子写;写不进去(目录只读之类)就算了,绝不能因为记账把主流程带走"""
    try:
        tmp = path + ".tmp-" + str(os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        try:
            os.chmod(tmp, 0o664)
        except OSError:
            pass
        os.replace(tmp, path)
    except Exception as e:
        _log("状态文件写入失败(" + str(path) + "): " + str(e))


# ---------- 耗尽标记 ----------
def _flag():
    return _read_json(FLAG_PATH, {})


def is_exhausted_error(err):
    return bool(EXHAUSTED_RE.search(str(err or "")))


def grok_exhausted():
    """标记存在且还在冷却期内 = 现在别指望 grok"""
    f = _flag()
    ts = f.get("ts")
    if not isinstance(ts, (int, float)):
        return False
    return (time.time() - ts) < RETRY_MIN * 60


def exhausted_info():
    f = _flag()
    ts = f.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    return {
        "since": datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d %H:%M"),
        "reason": f.get("reason") or "",
        "retryAt": datetime.fromtimestamp(ts + RETRY_MIN * 60, CST).strftime("%m-%d %H:%M"),
        "stale": (time.time() - ts) >= RETRY_MIN * 60,
    }


def mark_grok_exhausted(reason=""):
    f = _flag()
    first = not isinstance(f.get("ts"), (int, float))
    _write_json(FLAG_PATH, {"ts": time.time(), "reason": str(reason)[:300], "streak": 0})
    if first:
        _log("grok 配额耗尽,已写标记 " + FLAG_PATH + ";%g 分钟后再拿它探一次路。" % RETRY_MIN + str(reason)[:200])
    return True


def clear_grok_exhausted():
    if isinstance(_flag().get("ts"), (int, float)):
        _log("grok 恢复,清除耗尽标记")
    try:
        os.unlink(FLAG_PATH)
    except OSError:
        pass


def note_grok_ok():
    if _flag():
        clear_grok_exhausted()


def note_grok_fail(err):
    """返回 True = 这次失败让 grok 进入「耗尽」状态"""
    if is_exhausted_error(err):
        mark_grok_exhausted(err)
        return True
    streak = int(_flag().get("streak") or 0) + 1
    if streak >= FAIL_STREAK:
        mark_grok_exhausted("连续 %d 次失败:%s" % (streak, str(err)[:200]))
        return True
    _write_json(FLAG_PATH, {"streak": streak})
    return False


# ---------- 费用记账 ----------
def _day_key():
    return datetime.now(CST).strftime("%Y-%m-%d")


def _est_usd(model, tin, tout, web_calls=0):
    pin, pout = PRICES.get(model, PRICES.get(OPENAI_MODEL, (0.05, 0.40)))
    return tin / 1e6 * pin + tout / 1e6 * pout + web_calls * WEB_SEARCH_CALL_USD


def record_cost(model, tin, tout, web_calls=0):
    """按北京时间自然日累计;跨天时把前一天汇总成一行日志(不设上限,只记账)"""
    usd = _est_usd(model, tin, tout, web_calls)
    st = _read_json(COST_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    today = _day_key()
    last = st.get("lastDay")
    if last and last != today and isinstance(days.get(last), dict):
        d = days[last]
        _log("日汇总 %s: OpenAI 备用 %s 次,in %s / out %s token,搜索 %s 次,估算 $%.4f"
             % (last, d.get("calls", 0), d.get("in", 0), d.get("out", 0), d.get("web", 0), float(d.get("usd", 0))))
    cur = days.get(today) if isinstance(days.get(today), dict) else {"calls": 0, "in": 0, "out": 0, "web": 0, "usd": 0.0}
    cur["calls"] = int(cur.get("calls", 0)) + 1
    cur["in"] = int(cur.get("in", 0)) + int(tin)
    cur["out"] = int(cur.get("out", 0)) + int(tout)
    cur["web"] = int(cur.get("web", 0)) + int(web_calls)
    cur["usd"] = round(float(cur.get("usd", 0)) + usd, 6)
    days[today] = cur
    for k in sorted(days.keys())[:-60]:  # 只留最近 60 天
        days.pop(k, None)
    _write_json(COST_PATH, {"lastDay": today, "days": days})
    return usd, float(cur["usd"])


def today_cost():
    st = _read_json(COST_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    return float((days.get(_day_key()) or {}).get("usd") or 0)


# ---------- OpenAI ----------
def openai_enabled():
    return bool(OPENAI_KEY)


def extract_text(data):
    """Responses API 的正文在 output[] 里 type=message 那项的 content[].type=output_text。
    SDK 才有 output_text 便捷属性,裸 HTTP 没有;nano 档的 output 里还会夹 reasoning 项,别取 output[0]。"""
    parts = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in (None, "message"):
            continue
        for c in item.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "output_text" and isinstance(c.get("text"), str):
                parts.append(c["text"])
    if parts:
        return "\n".join(parts)
    t = data.get("output_text")  # 万一将来官方加了这个字段
    if isinstance(t, str):
        return t
    if isinstance(t, list):
        return "\n".join(str(x) for x in t)
    return ""


def openai_call(prompt, web=False, timeout=None, label="", instructions=None):
    """走 Responses API。返回 (text, usd)。web=True 时挂上内置联网检索工具。"""
    if not OPENAI_KEY:
        raise RuntimeError("没有 OPENAI_API_KEY,OpenAI 备用未启用")
    model = OPENAI_WEB_MODEL if web else OPENAI_MODEL
    body = {"model": model, "input": prompt}
    if instructions:
        body["instructions"] = instructions
    if web:
        body["tools"] = [{"type": "web_search"}]
    proxies = {"http": OPENAI_PROXY, "https": OPENAI_PROXY} if OPENAI_PROXY else None
    t0 = time.time()
    r = requests.post(
        OPENAI_BASE + "/responses",
        headers={"Authorization": "Bearer " + OPENAI_KEY, "Content-Type": "application/json"},
        json=body,
        timeout=timeout or OPENAI_TIMEOUT,
        proxies=proxies,
    )
    if r.status_code != 200:
        raise RuntimeError("OpenAI %d: %s" % (r.status_code, r.text[:400]))
    data = r.json()
    text = extract_text(data)
    if not text.strip():
        raise RuntimeError("OpenAI 返回空正文: " + json.dumps(data)[:300])
    usage = data.get("usage") or {}
    tin = int(usage.get("input_tokens") or 0)
    tout = int(usage.get("output_tokens") or 0)
    web_calls = 0
    if web:
        for item in data.get("output") or []:
            if isinstance(item, dict) and str(item.get("type") or "").startswith("web_search"):
                web_calls += 1
    usd, day_usd = record_cost(model, tin, tout, web_calls)
    _log("provider=openai model=%s label=%s web=%d in=%d out=%d cost≈$%.4f 今日≈$%.4f %.0fs"
         % (model, label or "-", 1 if web else 0, tin, tout, usd, day_usd, time.time() - t0))
    return text, usd


# ---------- 统一入口 ----------
_NO_KEY_LOGGED = False  # 没配密钥时只提示一次,别把日志刷满


def ai_call(grok_fn, prompt, label="", web=False, timeout=None, instructions=None):
    """先 grok、耗尽时 OpenAI。

    grok_fn: 无参可调用,返回 str 或 (text, cost);抛异常表示失败。
    prompt : 给 OpenAI 用的提示词(grok 的提示词由 grok_fn 自己拿)。
    返回 (text, cost_usd_or_None, provider)
    """
    def _run_grok():
        out = grok_fn()
        text, cost = (out[0], out[1] if len(out) > 1 else None) if isinstance(out, tuple) else (out, None)
        note_grok_ok()
        _log("provider=grok label=%s cost≈%s"
             % (label or "-", ("$%.4f" % cost) if isinstance(cost, (int, float)) else "n/a"))
        return text, cost, "grok"

    if grok_exhausted():
        if not openai_enabled():
            info = exhausted_info() or {}
            raise RuntimeError("grok 配额耗尽(自 %s),且未配置 OPENAI_API_KEY,备用未启用" % info.get("since", "?"))
        _log("grok 耗尽中," + (label or "本次调用") + " 改走 OpenAI")
        text, usd = openai_call(prompt, web=web, timeout=timeout, label=label, instructions=instructions)
        return text, usd, "openai"

    try:
        return _run_grok()
    except Exception as e:
        tripped = note_grok_fail(e)
        if not tripped or not openai_enabled():
            global _NO_KEY_LOGGED
            if tripped and not openai_enabled() and not _NO_KEY_LOGGED:
                _NO_KEY_LOGGED = True
                _log("grok 已判定耗尽,但没有 OPENAI_API_KEY,备用未启用,按原样报错(本进程只提示这一次)")
            raise
        _log("grok 耗尽(" + str(e)[:120] + ")," + (label or "本次调用") + " 改走 OpenAI")
        text, usd = openai_call(prompt, web=web, timeout=timeout, label=label, instructions=instructions)
        return text, usd, "openai"


if __name__ == "__main__":
    # 运维小工具:python3 lib/ai_fallback.py [status|clear]
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "clear":
        clear_grok_exhausted()
        print("已清除")
    else:
        print(json.dumps({
            "stateDir": STATE_DIR,
            "exhausted": grok_exhausted(),
            "flag": exhausted_info(),
            "openaiEnabled": openai_enabled(),
            "model": OPENAI_MODEL,
            "webModel": OPENAI_WEB_MODEL,
            "todayUsd": today_cost(),
        }, ensure_ascii=False, indent=1))
