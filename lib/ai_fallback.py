#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Grok 主用 / Codex CLI 备用的共用小模块(python 侧)。

背景:grok 走 SuperGrok 周配额,用完后 CLI 退出码 1、正文里是
    API error (status 402 Payment Required): Grok Build usage balance exhausted
这时四条链路的行为(2026-09-20 用户拍板):
  * BTT 新帖速览、名人发币速览、空投雷达 —— 切到 Codex CLI 接着跑;
  * NFT 打新追踪 —— 直接暂停,不走备用(每次联网核查约 5 万 token,等 grok 换号回来)。

备用不是 OpenAI API,而是**用户自己的 ChatGPT 订阅**:服务器上装了 @openai/codex,
以 riskdesk 用户、HOME=/opt/riskdesk 跑过一次设备码登录,登录态在 $CODEX_HOME/auth.json。
所以这里既不需要也不接受 OPENAI_API_KEY —— 备用是 spawn 一个 `codex exec`。

省钱/省 token 的取法(09-20 在服务器上实测):
  * 模型:订阅侧能用的最小一档是 gpt-5.6-luna(Fast and affordable);没有 nano/mini。
    还有个隐藏档 gpt-reserve 也能跑,想换设 CODEX_MODEL 即可。
  * 推理强度:luna 只认 low/medium/high/xhigh/max,minimal 会直接退出码 1,所以默认 low。
  * 联网:`codex exec` 没有 --search(那是顶层 flag),要用 `-c tools.web_search=true`,
    只在空投发现那一路开;BTT/名人速览不开。
  * 提示词自己精简(调用方负责),输出用 --output-schema 约束,少写解释就少花 token。

对外只有几件事:
    ai_call(grok_fn, prompt, ...)          先 grok、必要时 codex,返回 (text, tokens, provider)
    grok_exhausted()                       标记还在冷却期内吗(NFT 用它决定是否跳过本轮)
    note_grok_ok() / note_grok_fail(err)   给不走 ai_call 的调用点手动记账用
    codex_enabled()                        codex 装了没、登录了没

状态文件(默认 $HOME,服务器上四个服务的 HOME 都是 /opt/riskdesk,所以天然共享):
    .grok-exhausted         JSON:{"ts":…,"reason":…,"streak":…}  —— 耗尽标记 + 连败计数
    .ai-fallback-usage.json JSON:{"lastDay":…,"days":{"2026-09-20":{...}}}  —— 按天记 token
codex 没装或没登录时备用不启用,行为与加这个模块之前完全一致(只多一条日志)。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))

# ---------- 配置 ----------
STATE_DIR = os.environ.get("AI_FALLBACK_DIR") or os.path.expanduser("~")
FLAG_PATH = os.path.join(STATE_DIR, ".grok-exhausted")
USAGE_PATH = os.path.join(STATE_DIR, ".ai-fallback-usage.json")
# 标记多久后再试一次 grok(分钟)。到点后任何一条链路的下一次调用都会拿 grok 探一次路,
# 成功就清标记(NFT 也跟着自动恢复),还是 402 就把标记时间往后推 4 小时。
# 09-20 用户拍板:探路间隔 1 小时 → 4 小时(周配额不可能一小时就回血,白撞一次浪费)。
RETRY_MIN = float(os.environ.get("AI_GROK_RETRY_MIN", "240"))
# 非 402 的普通失败连着这么多次也算「grok 不可用」,免得网络烂掉时一直干等
FAIL_STREAK = int(os.environ.get("AI_GROK_FAIL_STREAK", "5"))

# codex 可执行文件:服务器上是 /opt/riskdesk-node/bin/codex(不在 systemd 的 PATH 里,要写全)
CODEX_BIN = (os.environ.get("CODEX_BIN") or "codex").strip()
# 订阅侧最小一档;没有 nano/mini(09-20 实测 codex 的 models_cache 里只有 5.5/5.6/6 系)
CODEX_MODEL = (os.environ.get("CODEX_MODEL") or "gpt-5.6-luna").strip()
CODEX_WEB_MODEL = (os.environ.get("CODEX_WEB_MODEL") or CODEX_MODEL).strip()
# luna 不认 minimal,low 是它支持的最低档
CODEX_EFFORT = (os.environ.get("CODEX_REASONING_EFFORT") or "low").strip()
CODEX_TIMEOUT = int(os.environ.get("CODEX_TIMEOUT_SEC", "600"))
CODEX_PROXY = (os.environ.get("CODEX_PROXY") or "").strip()
# 明确关掉备用的开关(留给排障用)
CODEX_OFF = (os.environ.get("CODEX_FALLBACK") or "").strip() in ("0", "off", "false", "no")

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


# ---------- 用量记账(订阅制没有按次美元,记 token 就够看趋势) ----------
def _day_key():
    return datetime.now(CST).strftime("%Y-%m-%d")


def record_usage(model, usage, web_calls=0):
    """按北京时间自然日累计 token;跨天时把前一天汇总成一行日志。不设上限,只记账。"""
    tin = int(usage.get("input_tokens") or 0)
    tout = int(usage.get("output_tokens") or 0)
    cached = int(usage.get("cached_input_tokens") or 0)
    think = int(usage.get("reasoning_output_tokens") or 0)
    st = _read_json(USAGE_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    today = _day_key()
    last = st.get("lastDay")
    if last and last != today and isinstance(days.get(last), dict):
        d = days[last]
        _log("日汇总 %s: codex 备用 %s 次,in %s(缓存 %s)/ out %s(其中推理 %s),搜索 %s 次"
             % (last, d.get("calls", 0), d.get("in", 0), d.get("cached", 0),
                d.get("out", 0), d.get("reasoning", 0), d.get("web", 0)))
    cur = days.get(today) if isinstance(days.get(today), dict) else {
        "calls": 0, "in": 0, "out": 0, "cached": 0, "reasoning": 0, "web": 0}
    cur["calls"] = int(cur.get("calls", 0)) + 1
    cur["in"] = int(cur.get("in", 0)) + tin
    cur["out"] = int(cur.get("out", 0)) + tout
    cur["cached"] = int(cur.get("cached", 0)) + cached
    cur["reasoning"] = int(cur.get("reasoning", 0)) + think
    cur["web"] = int(cur.get("web", 0)) + int(web_calls)
    days[today] = cur
    for k in sorted(days.keys())[:-60]:  # 只留最近 60 天
        days.pop(k, None)
    _write_json(USAGE_PATH, {"lastDay": today, "days": days})
    return tin + tout, int(cur["in"]) + int(cur["out"])


def today_tokens():
    st = _read_json(USAGE_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    d = days.get(_day_key()) or {}
    return int(d.get("in") or 0) + int(d.get("out") or 0)


# ---------- Codex CLI ----------
def codex_path():
    """CODEX_BIN 写的是全路径就用它,否则在 PATH 里找"""
    if not CODEX_BIN:
        return None
    if os.path.sep in CODEX_BIN or "/" in CODEX_BIN:
        return CODEX_BIN if os.path.exists(CODEX_BIN) else None
    return shutil.which(CODEX_BIN)


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def codex_enabled():
    """装了 + 登录过(auth.json 在)才算启用。登录态没了就退回「备用不启用」,行为照旧。"""
    if CODEX_OFF:
        return False
    if not codex_path():
        return False
    return os.path.isfile(os.path.join(codex_home(), "auth.json"))


def _strict_schema(node):
    """OpenAI 的结构化输出是 strict 模式:object 必须 additionalProperties:false 且 required 列全字段。
    调用方给的 schema 往往只写了 properties,这里补齐,省得因为格式被打回来再花一次 token。"""
    if not isinstance(node, dict):
        return node
    out = dict(node)
    props = out.get("properties")
    if out.get("type") == "object" and isinstance(props, dict):
        out["properties"] = {k: _strict_schema(v) for k, v in props.items()}
        out["required"] = list(out["properties"].keys())
        out["additionalProperties"] = False
    items = out.get("items")
    if isinstance(items, dict):
        out["items"] = _strict_schema(items)
    return out


def _parse_events(path):
    """--json 是 JSONL 事件流。要的东西:最后的 agent_message(兜底)、turn.completed 的 usage、
    web_search 次数、以及 error 事件(codex 出错时正文在这里,stderr 可能是空的)。"""
    usage, web_calls, last_msg, errs = {}, 0, "", []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                t = ev.get("type")
                if t == "turn.completed" and isinstance(ev.get("usage"), dict):
                    usage = ev["usage"]
                elif t == "turn.failed" or t == "error":
                    errs.append(json.dumps(ev.get("error") or ev, ensure_ascii=False)[:300])
                elif t == "item.completed" and isinstance(ev.get("item"), dict):
                    it = ev["item"]
                    if it.get("type") == "web_search":
                        web_calls += 1
                    elif it.get("type") == "agent_message" and isinstance(it.get("text"), str):
                        last_msg = it["text"]
    except Exception:
        pass
    return usage, web_calls, last_msg, errs


def codex_call(prompt, web=False, timeout=None, label="", instructions=None, schema=None):
    """spawn 一次 `codex exec`,返回 (text, tokens)。

    web=True 时打开内置网页检索(只给空投发现用)。schema 给了就走 --output-schema,
    最后一条回复直接是 JSON 对象;模型不认时调用方原有的「从 ```json 代码块抠」仍然管用。
    """
    binp = codex_path()
    if not binp:
        raise RuntimeError("找不到 codex 可执行文件(CODEX_BIN=%s),备用未启用" % CODEX_BIN)
    if not os.path.isfile(os.path.join(codex_home(), "auth.json")):
        raise RuntimeError("codex 未登录(%s/auth.json 不存在),备用未启用" % codex_home())
    model = CODEX_WEB_MODEL if web else CODEX_MODEL
    full = (instructions.rstrip() + "\n\n" + prompt) if instructions else prompt

    def _run(effort):
        # 每次一个全新的空工作目录:read-only 沙箱 + 空目录,codex 读不到仓库也捡不到 AGENTS.md
        work = tempfile.mkdtemp(prefix="codex-run-")
        try:
            evp = os.path.join(work, "events.jsonl")
            outp = os.path.join(work, "last.txt")
            cwd = os.path.join(work, "cwd")
            os.makedirs(cwd, exist_ok=True)
            argv = [binp, "exec", "-C", cwd, "-s", "read-only",
                    "--skip-git-repo-check", "--ephemeral", "-m", model,
                    # 值不加引号:TOML 解析不出来时 codex 按裸字符串用,省掉一层 Windows/cmd 引号地狱
                    "-c", "model_reasoning_effort=%s" % effort,
                    "--json", "-o", outp]
            if web:
                # `codex exec` 没有 --search(顶层才有),配置项才是通用写法
                argv += ["-c", "tools.web_search=true"]
            if schema:
                sp = os.path.join(work, "schema.json")
                with open(sp, "w", encoding="utf-8") as f:
                    json.dump(_strict_schema(schema), f, ensure_ascii=False)
                argv += ["--output-schema", sp]
            argv.append("-")  # 提示词走 stdin,长文不受 argv 长度限制
            env = dict(os.environ)
            if CODEX_PROXY:
                for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    env[k] = CODEX_PROXY
                env["NO_PROXY"] = "localhost,127.0.0.1,::1,.local"
            t0 = time.time()
            with open(evp, "wb") as ev:
                proc = subprocess.run(argv, input=full.encode("utf-8"), stdout=ev,
                                      stderr=subprocess.PIPE,
                                      timeout=timeout or CODEX_TIMEOUT, env=env)
            secs = time.time() - t0
            usage, web_calls, last_msg, errs = _parse_events(evp)
            text = ""
            try:
                with open(outp, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except OSError:
                pass
            if not text.strip():
                text = last_msg
            err_tail = (proc.stderr or b"").decode("utf-8", "replace")[-400:]
            return proc.returncode, text, usage, web_calls, errs, err_tail, secs
        finally:
            shutil.rmtree(work, ignore_errors=True)

    rc, text, usage, web_calls, errs, err_tail, secs = _run(CODEX_EFFORT)
    if rc != 0 and CODEX_EFFORT != "low":
        # 小模型只认 low/medium/high…,minimal 之类会直接退出码 1,降一档再来一次
        _log("codex 不认 model_reasoning_effort=%s,改用 low 重试" % CODEX_EFFORT)
        rc, text, usage, web_calls, errs, err_tail, secs = _run("low")
    if rc != 0:
        raise RuntimeError("codex 退出码 %s: %s" % (rc, (" | ".join(errs) + " " + err_tail).strip()[:500]))
    if not text.strip():
        raise RuntimeError("codex 返回空正文: " + (" | ".join(errs) + " " + err_tail).strip()[:300])
    tokens, day_tokens = record_usage(model, usage, web_calls)
    _log("provider=codex model=%s label=%s web=%d in=%d(缓存 %d)out=%d 搜索=%d 今日 %d token %.0fs"
         % (model, label or "-", 1 if web else 0,
            int(usage.get("input_tokens") or 0), int(usage.get("cached_input_tokens") or 0),
            int(usage.get("output_tokens") or 0), web_calls, day_tokens, secs))
    return text, tokens


# ---------- 统一入口 ----------
_NO_CODEX_LOGGED = False  # 没装/没登录时只提示一次,别把日志刷满


def ai_call(grok_fn, prompt, label="", web=False, timeout=None, instructions=None, schema=None):
    """先 grok、耗尽时 codex。

    grok_fn: 无参可调用,返回 str 或 (text, cost);抛异常表示失败。
    prompt : 给 codex 用的提示词(grok 的提示词由 grok_fn 自己拿)。越短越省。
    schema : 可选 JSON Schema,走 codex 的 --output-schema。
    返回 (text, tokens_or_None, provider)
    """
    def _run_grok():
        out = grok_fn()
        text, cost = (out[0], out[1] if len(out) > 1 else None) if isinstance(out, tuple) else (out, None)
        note_grok_ok()
        _log("provider=grok label=%s cost≈%s"
             % (label or "-", ("$%.4f" % cost) if isinstance(cost, (int, float)) else "n/a"))
        return text, cost, "grok"

    if grok_exhausted():
        if not codex_enabled():
            info = exhausted_info() or {}
            raise RuntimeError("grok 配额耗尽(自 %s),且 codex 未安装/未登录,备用未启用" % info.get("since", "?"))
        _log("grok 耗尽中," + (label or "本次调用") + " 改走 codex")
        text, tokens = codex_call(prompt, web=web, timeout=timeout, label=label,
                                  instructions=instructions, schema=schema)
        return text, tokens, "codex"

    try:
        return _run_grok()
    except Exception as e:
        tripped = note_grok_fail(e)
        if not tripped or not codex_enabled():
            global _NO_CODEX_LOGGED
            if tripped and not codex_enabled() and not _NO_CODEX_LOGGED:
                _NO_CODEX_LOGGED = True
                _log("grok 已判定耗尽,但 codex 未安装/未登录,备用未启用,按原样报错(本进程只提示这一次)")
            raise
        _log("grok 耗尽(" + str(e)[:120] + ")," + (label or "本次调用") + " 改走 codex")
        text, tokens = codex_call(prompt, web=web, timeout=timeout, label=label,
                                  instructions=instructions, schema=schema)
        return text, tokens, "codex"


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
            "retryMin": RETRY_MIN,
            "codexEnabled": codex_enabled(),
            "codexBin": codex_path(),
            "codexHome": codex_home(),
            "model": CODEX_MODEL,
            "webModel": CODEX_WEB_MODEL,
            "effort": CODEX_EFFORT,
            "todayTokens": today_tokens(),
        }, ensure_ascii=False, indent=1))
