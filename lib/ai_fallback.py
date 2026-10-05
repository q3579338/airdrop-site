#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Grok 主用 / Gemini CLI 备用(其次 Codex CLI)的共用小模块(python 侧)。

背景:grok 走 SuperGrok 周配额,用完后 CLI 退出码 1、正文里是
    API error (status 402 Payment Required): Grok Build usage balance exhausted
这时四条链路的行为(2026-09-20 用户拍板):
  * BTT 新帖速览、名人发币速览、空投雷达 —— 切到备用接着跑;
  * NFT 打新追踪 —— 直接暂停,不走备用(每次联网核查约 5 万 token,等 grok 换号回来)。

备用的次序(2026-10-06 改):**先 gemini,再 codex**。
  * gemini:服务器用私有 node 装了 @google/gemini-cli,以 riskdesk 用户、HOME=/opt/riskdesk
    做过一次「手输授权码」登录(服务器没浏览器),登录态在 $HOME/.gemini/。免费档够用。
  * codex:原来的 ChatGPT 订阅,订阅到期后自然失效,留着当第二道。
  两边都不需要 API key(gemini 若设了 GEMINI_API_KEY 也认,但那是用户自己写进 env 的)。

gemini CLI 的真实用法(0.62.0 实测,别按直觉猜):
  * 非交互:有 `-p/--prompt` 就进 headless;stdin 的内容会拼在 -p 的值**前面**
    (input = stdin + "\\n\\n" + p),所以提示词走 stdin、`-p` 传空串最干净。
  * 模型:`-m` 认别名 flash-lite / flash / pro / auto,比写死版本号抗升级。
  * 输出:`-o json` 吐 {session_id, response, stats, error};token 在
    stats.models[模型].tokens.{prompt,candidates,cached,thoughts},
    检索次数在 stats.tools.byName.google_web_search.count。
  * 没有 --output-schema 这种东西,结构化输出只能写进提示词再从 ```json 代码块抠。
  * 联网检索是内置工具 `google_web_search`,不是开关;要「不联网」就得把它关掉——
    在那个临时工作目录里写一份 .gemini/settings.json,tools.exclude 列黑名单,
    再配 --skip-trust(不信任的目录连这份设置都不读)。只有空投发现那一路放开检索。
    别用 GEMINI_CLI_SYSTEM_SETTINGS_PATH:它要求文件的父目录属 root,服务用户写不出来,
    整份会被静默跳过 —— 那就等于检索压根没关掉。
  * cwd 会被扫 GEMINI.md,所以每次给一个全新空目录(不然 /root 之类直接 EACCES 崩)。

对外只有几件事:
    ai_call(grok_fn, prompt, ...)          先 grok、必要时备用,返回 (text, tokens, provider)
    fallback_call(prompt, ...)             只走备用:先 gemini 再 codex,返回 (text, tokens, provider)
    grok_exhausted()                       标记还在冷却期内吗(NFT 用它决定是否跳过本轮)
    note_grok_ok() / note_grok_fail(err)   给不走 ai_call 的调用点手动记账用
    gemini_enabled() / codex_enabled()     各自装了没、登录了没

状态文件(默认 $HOME,服务器上四个服务的 HOME 都是 /opt/riskdesk,所以天然共享):
    .grok-exhausted         JSON:{"ts":…,"reason":…,"streak":…}  —— 耗尽标记 + 连败计数
    .ai-fallback-usage.json JSON:{"lastDay":…,"days":{"2026-10-06":{"gemini":{…},"codex":{…}}}}
gemini 和 codex 都没装/没登录时备用不启用,行为与加这个模块之前完全一致(只多一条日志)。
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

# gemini 可执行文件:服务器上是 /opt/riskdesk-node/bin/gemini(同样不在 systemd 的 PATH 里)
GEMINI_BIN = (os.environ.get("GEMINI_BIN") or "gemini").strip()
# 用别名而不是版本号:flash-lite 是最省的一档,CLI 自己映射到当时的实际模型
GEMINI_MODEL = (os.environ.get("AI_GEMINI_MODEL") or "flash-lite").strip()
GEMINI_WEB_MODEL = (os.environ.get("AI_GEMINI_WEB_MODEL") or GEMINI_MODEL).strip()
# flash-lite 这档账号没开通时降一档重试一次
GEMINI_MODEL_FALLBACK = (os.environ.get("AI_GEMINI_MODEL_FALLBACK") or "flash").strip()
GEMINI_TIMEOUT = int(os.environ.get("AI_GEMINI_TIMEOUT_SEC", "600"))
GEMINI_PROXY = (os.environ.get("AI_GEMINI_PROXY") or "").strip()
GEMINI_OFF = (os.environ.get("GEMINI_FALLBACK") or "").strip() in ("0", "off", "false", "no")

# gemini 的联网检索工具名(0.62.0:WEB_SEARCH_TOOL_NAME)
GEMINI_SEARCH_TOOL = "google_web_search"
# 不联网那路要关掉的内置工具。顺手把能动文件/跑命令的也关了:
# 我们只要它张嘴说话,不要它干活,少挂一个工具就少一份工具定义的 token。
GEMINI_DENY_BASE = [
    "run_shell_command",
    "write_file",
    "replace",
    "read_file",
    "read_many_files",
    "glob",
    "search_file_content",
    "list_directory",
    "save_memory",
    "write_todos",
    "web_fetch",
]
# 模型这一档没开通/名字不认时才值得换个模型重试;配额类错误换模型也没用
GEMINI_MODEL_ERR_RE = re.compile(
    r"model|not found|unsupported|unavailable|invalid argument|404|permission|entitle", re.I
)

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


# ---------- 用量记账(订阅制/免费档没有按次美元,记 token 就够看趋势) ----------
def _day_key():
    return datetime.now(CST).strftime("%Y-%m-%d")


_EMPTY_BUCKET = {"calls": 0, "in": 0, "out": 0, "cached": 0, "reasoning": 0, "web": 0}


def _buckets_of(day):
    """一天一行里按 provider 分桶;老文件是扁平的(只有 codex),读的时候当成 codex 桶"""
    if not isinstance(day, dict):
        return {}
    out, legacy = {}, {}
    for k, v in day.items():
        if isinstance(v, dict):
            out[k] = v
        elif isinstance(v, (int, float)):
            legacy[k] = v
    if legacy and "codex" not in out:
        out["codex"] = legacy  # 10-06 之前的扁平格式
    return out


def _sum_tokens(day):
    n = 0
    for b in _buckets_of(day).values():
        n += int(b.get("in") or 0) + int(b.get("out") or 0)
    return n


def record_usage(provider, model, usage, web_calls=0):
    """按北京时间自然日、按 provider 分别累计 token;跨天时把前一天汇总成一行日志。不设上限,只记账。"""
    tin = int(usage.get("input_tokens") or 0)
    tout = int(usage.get("output_tokens") or 0)
    cached = int(usage.get("cached_input_tokens") or 0)
    think = int(usage.get("reasoning_output_tokens") or 0)
    st = _read_json(USAGE_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    today = _day_key()
    last = st.get("lastDay")
    if last and last != today and isinstance(days.get(last), dict):
        parts = [
            "%s %s 次 in %s(缓存 %s)/ out %s(其中推理 %s),搜索 %s 次"
            % (p, d.get("calls", 0), d.get("in", 0), d.get("cached", 0),
               d.get("out", 0), d.get("reasoning", 0), d.get("web", 0))
            for p, d in _buckets_of(days[last]).items()
        ]
        _log("日汇总 %s: %s" % (last, " | ".join(parts) or "无备用调用"))
    day = dict(_buckets_of(days.get(today))) if isinstance(days.get(today), dict) else {}
    key = str(provider or "unknown")
    cur = dict(day.get(key)) if isinstance(day.get(key), dict) else dict(_EMPTY_BUCKET)
    cur["calls"] = int(cur.get("calls", 0)) + 1
    cur["in"] = int(cur.get("in", 0)) + tin
    cur["out"] = int(cur.get("out", 0)) + tout
    cur["cached"] = int(cur.get("cached", 0)) + cached
    cur["reasoning"] = int(cur.get("reasoning", 0)) + think
    cur["web"] = int(cur.get("web", 0)) + int(web_calls)
    cur["model"] = str(model or "")
    day[key] = cur
    days[today] = day
    for k in sorted(days.keys())[:-60]:  # 只留最近 60 天
        days.pop(k, None)
    _write_json(USAGE_PATH, {"lastDay": today, "days": days})
    return tin + tout, _sum_tokens(day)


def today_tokens(provider=""):
    """今天所有备用 provider 加起来的 token;给了 provider 就只算那一个"""
    st = _read_json(USAGE_PATH, {})
    days = st.get("days") if isinstance(st.get("days"), dict) else {}
    day = days.get(_day_key()) or {}
    if not provider:
        return _sum_tokens(day)
    b = _buckets_of(day).get(provider) or {}
    return int(b.get("in") or 0) + int(b.get("out") or 0)


# ---------- 公用:找可执行文件 ----------
def _resolve_bin(name):
    """写的是全路径就用它,否则在 PATH 里找"""
    if not name:
        return None
    if os.path.sep in name or "/" in name:
        return name if os.path.exists(name) else None
    return shutil.which(name)


def _strict_schema(node):
    """OpenAI 的结构化输出是 strict 模式:object 必须 additionalProperties:false 且 required 列全字段。
    调用方给的 schema 往往只写了 properties,这里补齐,省得因为格式被打回来再花一次 token。
    gemini 没有 --output-schema,但补齐后的 schema 写进提示词也更明确。"""
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


# ---------- Codex CLI ----------
def codex_path():
    return _resolve_bin(CODEX_BIN)


def codex_home():
    return os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")


def codex_enabled():
    """装了 + 登录过(auth.json 在)才算启用。登录态没了就退回「备用不启用」,行为照旧。"""
    if CODEX_OFF:
        return False
    if not codex_path():
        return False
    return os.path.isfile(os.path.join(codex_home(), "auth.json"))


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
        raise RuntimeError("找不到 codex 可执行文件(CODEX_BIN=%s),codex 备用未启用" % CODEX_BIN)
    if not os.path.isfile(os.path.join(codex_home(), "auth.json")):
        raise RuntimeError("codex 未登录(%s/auth.json 不存在),codex 备用未启用" % codex_home())
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
    tokens, day_tokens = record_usage("codex", model, usage, web_calls)
    _log("provider=codex model=%s label=%s web=%d in=%d(缓存 %d)out=%d 搜索=%d 今日 %d token %.0fs"
         % (model, label or "-", 1 if web else 0,
            int(usage.get("input_tokens") or 0), int(usage.get("cached_input_tokens") or 0),
            int(usage.get("output_tokens") or 0), web_calls, day_tokens, secs))
    return text, tokens


# ---------- Gemini CLI ----------
def gemini_path():
    return _resolve_bin(GEMINI_BIN)


def gemini_home():
    """gemini CLI 的配置目录:homedir 可以用 GEMINI_CLI_HOME 顶掉(CLI 自己也认这个变量)"""
    return (os.environ.get("GEMINI_CLI_HOME") or "").strip() or os.path.expanduser("~")


def gemini_dir():
    return os.path.join(gemini_home(), ".gemini")


def gemini_logged_in():
    """登录过没有。oauth 登录态按版本落在这几个文件里的任意一个
    (oauth_creds.json 是老位置,gemini-credentials.json 是文件钥匙串,
    google_accounts.json 是登录后缓存的账号)。用户自己写进 env 的 GEMINI_API_KEY 也算。"""
    if (os.environ.get("GEMINI_API_KEY") or "").strip():
        return True
    d = gemini_dir()
    for f in ("oauth_creds.json", "gemini-credentials.json", "google_accounts.json"):
        if os.path.isfile(os.path.join(d, f)):
            return True
    return False


def gemini_enabled():
    """装了 + 登录过才算启用。没有就退回 codex,再退回「备用不启用」,行为照旧。"""
    if GEMINI_OFF:
        return False
    if not gemini_path():
        return False
    return gemini_logged_in()


def _schema_hint(schema):
    """没有 --output-schema,只能把 schema 写进提示词"""
    return ("\n\n只输出一个 JSON 对象,放在 ```json 代码块里,前后不要写任何解释。"
            "必须符合下面这个 JSON Schema:\n"
            + json.dumps(_strict_schema(schema), ensure_ascii=False))


_FENCE_RE = re.compile(r"^```(?:json)?[ \t]*\r?\n(.*?)\r?\n?```$", re.S | re.I)


def unfence_json(text):
    """整个回复就是一个 ```json 代码块时把壳剥掉——让调用方拿到的东西和 codex 的
    --output-schema 一样是裸 JSON。不是代码块(比如空投报告那种 markdown)就原样返回。"""
    s = str(text).strip()
    m = _FENCE_RE.match(s)
    if not m:
        return text
    inner = m.group(1).strip()
    try:
        json.loads(inner)
        return inner
    except Exception:
        return text


def parse_gemini_json(stdout):
    """`-o json` 只吐一个对象:{session_id, response, stats, error}。
    token 在 stats.models[模型].tokens,检索次数在 stats.tools.byName.google_web_search.count。
    返回 (text, usage, web_calls, errs)。"""
    s = str(stdout or "")
    obj = None
    i = s.find("{")
    if i >= 0:
        try:
            obj = json.loads(s[i:])
        except Exception:
            obj = None
    if not isinstance(obj, dict):
        obj = None
        for line in s.split("\n"):
            try:
                v = json.loads(line.strip())
            except Exception:
                continue
            if isinstance(v, dict):
                obj = v
    usage = {"input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "reasoning_output_tokens": 0}
    if not isinstance(obj, dict):
        return "", usage, 0, []
    stats = obj.get("stats") if isinstance(obj.get("stats"), dict) else {}
    models = stats.get("models") if isinstance(stats.get("models"), dict) else {}
    for mv in models.values():
        t = mv.get("tokens") if isinstance(mv, dict) and isinstance(mv.get("tokens"), dict) else {}
        usage["input_tokens"] += int(t.get("prompt") or t.get("input") or 0)
        usage["output_tokens"] += int(t.get("candidates") or 0)
        usage["cached_input_tokens"] += int(t.get("cached") or 0)
        usage["reasoning_output_tokens"] += int(t.get("thoughts") or 0)
    tools = stats.get("tools") if isinstance(stats.get("tools"), dict) else {}
    by_name = tools.get("byName") if isinstance(tools.get("byName"), dict) else {}
    hit = by_name.get(GEMINI_SEARCH_TOOL)
    web_calls = int(hit.get("count") or 0) if isinstance(hit, dict) else 0
    errs = []
    if obj.get("error"):
        e = obj["error"]
        errs.append((e if isinstance(e, str) else json.dumps(e, ensure_ascii=False))[:300])
    text = obj.get("response") if isinstance(obj.get("response"), str) else ""
    return text, usage, web_calls, errs


def gemini_call(prompt, web=False, timeout=None, label="", instructions=None, schema=None):
    """spawn 一次 `gemini -p`,返回 (text, tokens)。

    web=True 时放开内置的 google_web_search(只给空投发现用);其余情况把检索工具关掉。
    schema 给了就把 schema 写进提示词,回来的 ```json 代码块会被剥成裸 JSON。
    """
    binp = gemini_path()
    if not binp:
        raise RuntimeError("找不到 gemini 可执行文件(GEMINI_BIN=%s),gemini 备用未启用" % GEMINI_BIN)
    if not gemini_logged_in():
        raise RuntimeError("gemini 未登录(%s 里没有登录态),gemini 备用未启用" % gemini_dir())
    full = (instructions.rstrip() + "\n\n" + prompt) if instructions else prompt
    if schema:
        full += _schema_hint(schema)

    def _run(model):
        # 每次一个全新的空工作目录:gemini 会扫 cwd 找 GEMINI.md,目录不可读会直接崩
        work = tempfile.mkdtemp(prefix="gemini-run-")
        try:
            cwd = os.path.join(work, "cwd")
            os.makedirs(os.path.join(cwd, ".gemini"), exist_ok=True)
            # 工作目录级设置。本来想用 GEMINI_CLI_SYSTEM_SETTINGS_PATH(优先级最高),但 10-06 实测:
            # 系统级设置文件的父目录必须属 root,否则整份被跳过(只打一条 Security Warning)——
            # 服务跑在 riskdesk 下写不出这种目录,那就等于检索根本没关掉。工作目录级没有这个限制,
            # 配上 --skip-trust / GEMINI_CLI_TRUST_WORKSPACE=true 一定会被读进去(实测有生效回声)。
            # 注意:0.62 起 tools.exclude 带「1.0 将移除,迁 Policy Engine」的告警,升级时要跟进。
            deny = list(GEMINI_DENY_BASE) if web else [GEMINI_SEARCH_TOOL] + list(GEMINI_DENY_BASE)
            ws_settings = os.path.join(cwd, ".gemini", "settings.json")
            with open(ws_settings, "w", encoding="utf-8") as f:
                json.dump({
                    "tools": {"exclude": deny},
                    "privacy": {"usageStatisticsEnabled": False},
                    "telemetry": {"enabled": False},
                    "security": {"auth": {"selectedType":
                                          "gemini-api-key" if (os.environ.get("GEMINI_API_KEY") or "").strip()
                                          else "oauth-personal"}},
                }, f, ensure_ascii=False)
            argv = [binp, "-m", model, "-o", "json",
                    # 工具都关了,没有东西可批准;联网那路也只放开检索
                    "--approval-mode", "yolo", "--skip-trust",
                    # 有 -p 才进 headless;提示词走 stdin(会被拼在 -p 的值前面)
                    "-p", ""]
            env = dict(os.environ)
            # 不信任的工作目录会连 .gemini/settings.json 一起忽略
            env["GEMINI_CLI_TRUST_WORKSPACE"] = "true"
            env["GEMINI_FORCE_FILE_STORAGE"] = "true"  # 服务器没钥匙串,登录态固定走文件
            env["NO_BROWSER"] = "true"  # 登录态掉了也别去开浏览器,直接报错
            env["TERM"] = "dumb"
            if GEMINI_PROXY:
                for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
                    env[k] = GEMINI_PROXY
                env["NO_PROXY"] = "localhost,127.0.0.1,::1,.local"
            t0 = time.time()
            proc = subprocess.run(argv, input=full.encode("utf-8"), stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, cwd=cwd,
                                  timeout=timeout or GEMINI_TIMEOUT, env=env)
            secs = time.time() - t0
            out = (proc.stdout or b"").decode("utf-8", "replace")
            text, usage, web_calls, errs = parse_gemini_json(out)
            err_tail = (proc.stderr or b"").decode("utf-8", "replace")[-400:]
            return proc.returncode, text, usage, web_calls, errs, err_tail, secs, model
        finally:
            shutil.rmtree(work, ignore_errors=True)

    first = GEMINI_WEB_MODEL if web else GEMINI_MODEL
    rc, text, usage, web_calls, errs, err_tail, secs, model = _run(first)
    if (rc != 0 or not text.strip()) and GEMINI_MODEL_FALLBACK and GEMINI_MODEL_FALLBACK != first:
        why = (" | ".join(errs) + " " + err_tail).strip()
        if GEMINI_MODEL_ERR_RE.search(why):
            _log("gemini 模型 %s 用不了(%s),改用 %s 重试" % (first, why[:160], GEMINI_MODEL_FALLBACK))
            rc, text, usage, web_calls, errs, err_tail, secs, model = _run(GEMINI_MODEL_FALLBACK)
    if rc != 0:
        raise RuntimeError("gemini 退出码 %s: %s" % (rc, (" | ".join(errs) + " " + err_tail).strip()[:500]))
    if not text.strip():
        raise RuntimeError("gemini 返回空正文: " + (" | ".join(errs) + " " + err_tail).strip()[:300])
    tokens, day_tokens = record_usage("gemini", model, usage, web_calls)
    _log("provider=gemini model=%s label=%s web=%d in=%d(缓存 %d)out=%d 搜索=%d 今日 %d token %.0fs"
         % (model, label or "-", 1 if web else 0,
            int(usage.get("input_tokens") or 0), int(usage.get("cached_input_tokens") or 0),
            int(usage.get("output_tokens") or 0), web_calls, day_tokens, secs))
    return unfence_json(text), tokens


# ---------- 备用链:gemini → codex ----------
def fallback_enabled():
    """两条备用里有一条能用吗"""
    return gemini_enabled() or codex_enabled()


def fallback_provider():
    """现在会走哪条备用('gemini' / 'codex' / None)"""
    if gemini_enabled():
        return "gemini"
    if codex_enabled():
        return "codex"
    return None


def fallback_call(prompt, web=False, timeout=None, label="", instructions=None, schema=None):
    """优先 gemini,失败(或没装/没登录)再 codex。返回 (text, tokens, provider)"""
    if gemini_enabled():
        try:
            text, tokens = gemini_call(prompt, web=web, timeout=timeout, label=label,
                                       instructions=instructions, schema=schema)
            return text, tokens, "gemini"
        except Exception as e:
            if not codex_enabled():
                raise
            _log("gemini 备用失败(%s),%s 退回 codex" % (str(e)[:200], label or "本次调用"))
    text, tokens = codex_call(prompt, web=web, timeout=timeout, label=label,
                              instructions=instructions, schema=schema)
    return text, tokens, "codex"


# ---------- 统一入口 ----------
_NO_FALLBACK_LOGGED = False  # 两条备用都没有时只提示一次,别把日志刷满


def ai_call(grok_fn, prompt, label="", web=False, timeout=None, instructions=None, schema=None):
    """先 grok、耗尽时走备用(gemini 优先,其次 codex)。

    grok_fn: 无参可调用,返回 str 或 (text, cost);抛异常表示失败。
    prompt : 给备用用的提示词(grok 的提示词由 grok_fn 自己拿)。越短越省。
    schema : 可选 JSON Schema;codex 走 --output-schema,gemini 写进提示词。
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
        if not fallback_enabled():
            info = exhausted_info() or {}
            raise RuntimeError("grok 配额耗尽(自 %s),且 gemini / codex 都未安装或未登录,备用未启用"
                               % info.get("since", "?"))
        _log("grok 耗尽中," + (label or "本次调用") + " 改走 " + str(fallback_provider()))
        return fallback_call(prompt, web=web, timeout=timeout, label=label,
                             instructions=instructions, schema=schema)

    try:
        return _run_grok()
    except Exception as e:
        tripped = note_grok_fail(e)
        if not tripped or not fallback_enabled():
            global _NO_FALLBACK_LOGGED
            if tripped and not fallback_enabled() and not _NO_FALLBACK_LOGGED:
                _NO_FALLBACK_LOGGED = True
                _log("grok 已判定耗尽,但 gemini / codex 都未安装或未登录,备用未启用,按原样报错(本进程只提示这一次)")
            raise
        _log("grok 耗尽(" + str(e)[:120] + ")," + (label or "本次调用") + " 改走 " + str(fallback_provider()))
        return fallback_call(prompt, web=web, timeout=timeout, label=label,
                             instructions=instructions, schema=schema)


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
            "fallbackProvider": fallback_provider(),
            "geminiEnabled": gemini_enabled(),
            "geminiBin": gemini_path(),
            "geminiDir": gemini_dir(),
            "geminiModel": GEMINI_MODEL,
            "geminiWebModel": GEMINI_WEB_MODEL,
            "geminiModelFallback": GEMINI_MODEL_FALLBACK,
            "geminiTodayTokens": today_tokens("gemini"),
            "codexEnabled": codex_enabled(),
            "codexBin": codex_path(),
            "codexHome": codex_home(),
            "model": CODEX_MODEL,
            "webModel": CODEX_WEB_MODEL,
            "effort": CODEX_EFFORT,
            "codexTodayTokens": today_tokens("codex"),
            "todayTokens": today_tokens(),
        }, ensure_ascii=False, indent=1))
