#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bitcointalk 山寨币公告板(board=159)新帖监控 —— 服务器版。

原版 D:\\CLAUDE\\autofish\\monitorbitcoin.py 的推送逻辑原样保留:
  新帖 → Telegram 每帖一条(MarkdownV2 链接) + 微信 PushPlus 一轮合并一条;首次启动只记基准不推送;
  连续失败逐步退避,10/60 连败时微信告警。
在此之上:
  * 每个新帖入 SQLite(topic_id 主键,发现时间,推送状态);
  * 后台线程抓帖子首楼正文,交给 grok 生成中文速览(结构化 JSON),失败最多重试 3 次;
  * 每次有变化就把最近 N 帖导出 export.json(原子写),airdrop.satloot.com 的生成器读它渲染「BTT 新帖」。
配置全部走环境变量(systemd EnvironmentFile=/etc/btt-monitor.env),令牌不进代码。
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------- 配置 ----------
TG_TOKEN = os.environ.get("BTT_TG_TOKEN", "").strip()
TG_CHAT = os.environ.get("BTT_TG_CHAT", "").strip()
PUSHPLUS_TOKEN = os.environ.get("BTT_PUSHPLUS_TOKEN", "").strip()
BOARD_URL = os.environ.get("BTT_BOARD_URL", "https://bitcointalk.org/index.php?board=159.0")
CHECK_EVERY_SEC = int(os.environ.get("BTT_CHECK_EVERY_SEC", "300"))
DB_PATH = os.environ.get("BTT_DB", "/var/lib/btt-monitor/btt.sqlite")
EXPORT_PATH = os.environ.get("BTT_EXPORT", "/var/lib/btt-monitor/export.json")
EXPORT_LIMIT = int(os.environ.get("BTT_EXPORT_LIMIT", "300"))
ANALYSIS_ENABLED = os.environ.get("BTT_ANALYSIS", "1") != "0"
SEED_ANALYZE = os.environ.get("BTT_SEED_ANALYZE", "1") != "0"
GROK_BIN = os.environ.get("BTT_GROK_BIN", "grok")
GROK_MODEL = os.environ.get("BTT_GROK_MODEL", "grok-4.5")
GROK_TIMEOUT_SEC = int(os.environ.get("BTT_GROK_TIMEOUT_SEC", "240"))
GROK_PROXY = os.environ.get("BTT_GROK_PROXY", "").strip()  # 如 http://127.0.0.1:10809;空=直连
ANALYSIS_MAX_TRIES = 3
POST_MAX_CHARS = 6000
CST = timezone(timedelta(hours=8))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}
session = requests.Session()
session.headers.update(HEADERS)

# bitcointalk 响应头声明 ISO-8859-1,实际按 Windows-1252 发(短横线 0x96、引号 0x93 等):
# 按 latin-1 解会得到 C1 控制字符,浏览器显示成 �。与浏览器一致地按 cp1252 解;超出 cp1252 的字符站方用 HTML 实体,bs4 会还原。
C1_RE = re.compile(r"[\x80-\x9f]")


def fix_cp1252(s):
    """把已经按 latin-1 解错的 C1 控制字符再按 cp1252 解一次;正常文本不含这段字符,不受影响"""
    if not s or not C1_RE.search(s):
        return s
    return C1_RE.sub(lambda m: m.group(0).encode("latin-1").decode("cp1252", errors="replace"), s)


def get_html(url):
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    if (resp.encoding or "").lower() in ("", "iso-8859-1", "latin-1", "latin1"):
        resp.encoding = "cp1252"
    return resp.text

export_lock = threading.Lock()
stop_event = threading.Event()


def now_ms():
    return int(time.time() * 1000)


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ---------- SQLite ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS posts (
  topic_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  seeded INTEGER NOT NULL DEFAULT 0,
  pushed_tg INTEGER NOT NULL DEFAULT 0,
  pushed_wx INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  posted_at TEXT,
  post_text TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_json TEXT,
  analysis_raw TEXT,
  analysis_ts INTEGER,
  analysis_error TEXT,
  analysis_tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(analysis_status);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
"""


def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn


def meta_get(conn, k, default=None):
    row = conn.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return row["v"] if row else default


def meta_set(conn, k, v):
    conn.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, None if v is None else str(v)))
    conn.commit()


def event(conn, kind, detail=""):
    conn.execute("INSERT INTO events(ts,kind,detail) VALUES(?,?,?)", (now_ms(), kind, str(detail)[:2000]))
    conn.commit()


# ---------- 推送(与原版一致) ----------
def tg_escape(text):
    return re.sub(r"([_*\[\]()~`>#+\-=|{}.!<])", r"\\\1", text)


def tg_send(title, url):
    if not TG_TOKEN or not TG_CHAT:
        return False
    msg = f"[{tg_escape(title)}]({url})"
    for _ in range(3):
        try:
            r = session.post(
                f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                data={"chat_id": TG_CHAT, "text": msg,
                      "parse_mode": "MarkdownV2",
                      "disable_web_page_preview": True},
                timeout=30)
            if r.ok:
                return True
            log(f"TG返回异常: {r.status_code} {r.text[:200]}")
        except requests.RequestException as e:
            log(f"TG发送失败: {e}")
        time.sleep(2)
    return False


def wechat_send(topics):
    """topics: [(title, url)],一个周期合并成一条,防止 PushPlus 限频"""
    if not PUSHPLUS_TOKEN or not topics:
        return False
    if len(topics) == 1:
        title = f"BTT新帖: {topics[0][0][:50]}"
    else:
        title = f"BTT山寨板 {len(topics)} 条新帖"
    content = "\n\n".join(f"**{t}**\n[{u}]({u})" for t, u in topics)
    for _ in range(3):
        try:
            r = session.post("https://www.pushplus.plus/send",
                             json={"token": PUSHPLUS_TOKEN, "title": title,
                                   "content": content, "template": "markdown"},
                             timeout=30)
            if r.ok:
                return True
            log(f"PushPlus返回异常: {r.status_code} {r.text[:200]}")
        except requests.RequestException as e:
            log(f"微信推送失败: {e}")
        time.sleep(2)
    return False


# ---------- 抓板块 ----------
def fetch_topics():
    """返回 [(topic_id, title, url, pinned)],解析失败抛异常(与原版同一套判定)"""
    soup = BeautifulSoup(get_html(BOARD_URL), "html.parser")
    body = soup.find("div", {"id": "bodyarea"})
    if body is None:
        raise RuntimeError("页面结构异常: 找不到 bodyarea")
    table = body.find("table", {"border": "0", "width": "100%", "cellpadding": "4"})
    if table is None:
        raise RuntimeError("页面结构异常: 找不到主题表格")
    topics = []
    for row in table.find_all("tr"):
        try:
            span = row.find("span")
            link = row.find("a")
            if span is None or link is None:
                continue
            url = link.get("href", "")
            m = re.search(r"topic=(\d+)", url)
            if not m:
                continue
            pinned = row.find("td", {"class": "windowbg3"}) is not None
            topics.append((int(m.group(1)), span.text.strip(), url, pinned))
        except Exception:
            continue
    if not topics:
        raise RuntimeError("页面结构异常: 主题表格里没解析出任何帖子")
    return topics


# ---------- 抓帖子首楼 ----------
def fetch_first_post(topic_id):
    """返回 (author, posted_at, text);抓不到正文抛异常"""
    soup = BeautifulSoup(get_html(f"https://bitcointalk.org/index.php?topic={topic_id}.0"), "html.parser")
    post = soup.find("div", {"class": "post"})
    if post is None:
        raise RuntimeError("找不到首楼正文")
    for br in post.find_all("br"):
        br.replace_with("\n")
    text = re.sub(r"\n{3,}", "\n\n", post.get_text("\n")).strip()
    author = None
    info = soup.find("td", {"class": "poster_info"})
    if info is not None:
        a = info.find("a")
        if a is not None:
            author = a.get_text(strip=True)[:80]
    posted_at = None
    subj = soup.find("div", {"class": "subject"})
    if subj is not None:
        small = subj.find_next_sibling("div", {"class": "smalltext"})
        if small is not None:
            posted_at = small.get_text(" ", strip=True)[:80]
    return author, posted_at, text[:POST_MAX_CHARS]


# ---------- grok 速览 ----------
ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "kind": {"type": "string"},
        "chain": {"type": "string"},
        "token": {"type": "string"},
        "distribution": {"type": "string"},
        "highlights": {"type": "string"},
        "red_flags": {"type": "string"},
        "verdict": {"type": "string"},
        "score": {"type": "integer"},
        "mining": {"type": "string"},
    },
    "required": ["name", "kind", "chain", "token", "distribution", "highlights", "red_flags", "verdict", "score", "mining"],
}
ANALYSIS_KEYS = list(ANALYSIS_SCHEMA["properties"].keys())


def build_prompt(title, author, posted_at, text):
    return (
        "你是加密项目尽调助手。下面是 bitcointalk 山寨币公告板(Altcoin Announcements)一个新帖的标题与首楼正文"
        "(HTML 已去除,可能被截断)。只根据帖子内容判断,不要臆造帖子里没有的信息;帖子没提到的就写「未提及」。\n"
        "全部用简体中文作答,每个字段一到两句话,不要 Markdown。字段含义:\n"
        "name 项目名;kind 类型,只能取其一:代币发行 / ICO或预售 / 空投或Bounty / 矿币或PoW / NFT / DeFi协议 / 工具或服务 / 交易所或平台 / 其他 / 垃圾或广告;"
        "chain 所在链或平台;token 代币名称与代号;distribution 募资或分发方式(价格、总量、分配比例);highlights 亮点;"
        "red_flags 风险信号(匿名团队、无代码、承诺收益、仿冒抄袭、只发合约地址等);verdict 一句话结论;"
        "score 0 到 10 的整数,10 = 最值得跟进,0 = 纯垃圾或骗局;"
        "mining 挖矿方式,只能取其一:CPU可挖 / GPU可挖 / ASIC / 不可挖或非矿币 / 未提及(RandomX、yescrypt 等抗 ASIC 算法算 CPU可挖)。\n\n"
        f"标题:{title}\n楼主:{author or '未知'}\n发帖时间:{posted_at or '未知'}\n\n正文:\n{text}\n"
    )


def extract_json(stdout):
    """grok 结构化输出可能是裸 JSON,也可能带外壳;逐层尝试"""
    s = stdout.strip()
    try:
        obj = json.loads(s)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        if all(k in obj for k in ANALYSIS_KEYS):
            return obj
        # 外壳里找
        for v in obj.values():
            if isinstance(v, dict) and all(k in v for k in ANALYSIS_KEYS):
                return v
            if isinstance(v, str):
                try:
                    inner = json.loads(v)
                    if isinstance(inner, dict) and all(k in inner for k in ANALYSIS_KEYS):
                        return inner
                except Exception:
                    pass
    # 文本里最外层的一对花括号
    for m in re.finditer(r"\{[\s\S]*\}", s):
        try:
            inner = json.loads(m.group(0))
            if isinstance(inner, dict) and all(k in inner for k in ANALYSIS_KEYS):
                return inner
        except Exception:
            continue
    raise RuntimeError("输出里没有合规 JSON: " + s[:300])


def run_grok(prompt):
    fd, path = tempfile.mkstemp(prefix="btt-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(prompt)
    env = dict(os.environ)
    env["GROK_SUBAGENTS"] = "0"
    if GROK_PROXY:
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            env[k] = GROK_PROXY
        env["NO_PROXY"] = "localhost,127.0.0.1,::1,.local"
    argv = [GROK_BIN, "--prompt-file", path, "-m", GROK_MODEL, "--always-approve", "--no-subagents",
            "--disable-web-search", "--json-schema", json.dumps(ANALYSIS_SCHEMA, ensure_ascii=False)]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=GROK_TIMEOUT_SEC, env=env)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(f"grok 退出码 {proc.returncode}: {proc.stderr[-600:]}")
    return proc.stdout


def normalize_analysis(obj):
    out = {}
    for k in ANALYSIS_KEYS:
        v = obj.get(k)
        if k == "score":
            try:
                v = max(0, min(10, int(round(float(v)))))
            except Exception:
                v = None
        else:
            v = re.sub(r"\s+", " ", str(v if v is not None else "")).strip()[:600]
        out[k] = v
    return out


def analysis_worker():
    """后台线程:逐条处理 pending 帖子。与主线程各用各的连接。"""
    conn = open_db()
    log("速览线程启动")
    while not stop_event.is_set():
        row = conn.execute(
            "SELECT * FROM posts WHERE analysis_status IN ('pending','running') ORDER BY seeded ASC, topic_id DESC LIMIT 1"
        ).fetchone()
        if row is None:
            stop_event.wait(5)
            continue
        tid = row["topic_id"]
        conn.execute("UPDATE posts SET analysis_status='running', analysis_tries=analysis_tries+1 WHERE topic_id=?", (tid,))
        conn.commit()
        tries = row["analysis_tries"] + 1
        try:
            author, posted_at, text = row["author"], row["posted_at"], row["post_text"]
            if not text:
                author, posted_at, text = fetch_first_post(tid)
                conn.execute("UPDATE posts SET author=?, posted_at=?, post_text=? WHERE topic_id=?", (author, posted_at, text, tid))
                conn.commit()
            stdout = run_grok(build_prompt(row["title"], author, posted_at, text))
            analysis = normalize_analysis(extract_json(stdout))
            conn.execute(
                "UPDATE posts SET analysis_status='done', analysis_json=?, analysis_raw=?, analysis_ts=?, analysis_error=NULL WHERE topic_id=?",
                (json.dumps(analysis, ensure_ascii=False), stdout[-4000:], now_ms(), tid))
            conn.commit()
            log(f"速览完成 #{tid} {row['title'][:40]} → {analysis.get('kind')} / {analysis.get('score')}分")
            event(conn, "analysis_done", f"#{tid} score={analysis.get('score')}")
        except Exception as e:
            err = str(e)[:800]
            status = "failed" if tries >= ANALYSIS_MAX_TRIES else "pending"
            conn.execute("UPDATE posts SET analysis_status=?, analysis_error=?, analysis_ts=? WHERE topic_id=?",
                         (status, err, now_ms(), tid))
            conn.commit()
            log(f"速览失败 #{tid}(第 {tries} 次): {err[:200]}")
            event(conn, "analysis_failed", f"#{tid} try={tries} {err[:300]}")
            if status == "pending":
                stop_event.wait(20)
        export_json(conn)


# ---------- 导出给网站 ----------
def export_json(conn):
    with export_lock:
        rows = conn.execute(
            "SELECT topic_id,title,url,first_seen_ts,seeded,author,posted_at,analysis_status,analysis_json,analysis_ts,analysis_error "
            "FROM posts ORDER BY first_seen_ts DESC, topic_id DESC LIMIT ?", (EXPORT_LIMIT,)).fetchall()
        today_start = datetime.now(CST).replace(hour=0, minute=0, second=0, microsecond=0)
        today_ms = int(today_start.timestamp() * 1000)
        total = conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
        analyzed = conn.execute("SELECT COUNT(*) FROM posts WHERE analysis_status='done'").fetchone()[0]
        today_count = conn.execute("SELECT COUNT(*) FROM posts WHERE first_seen_ts>=? AND seeded=0", (today_ms,)).fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM posts WHERE analysis_status IN ('pending','running')").fetchone()[0]

        def iso(ms):
            return None if ms is None else datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()

        data = {
            "generatedAt": iso(now_ms()),
            "boardUrl": BOARD_URL,
            "lastCheckAt": iso(meta_get(conn, "last_check_ts")),
            "lastOkAt": iso(meta_get(conn, "last_ok_ts")),
            "lastError": meta_get(conn, "last_error"),
            "failStreak": int(meta_get(conn, "fail_streak", 0) or 0),
            "lastTopicId": int(meta_get(conn, "last_id", 0) or 0),
            "checkEverySec": CHECK_EVERY_SEC,
            "count": total,
            "todayCount": today_count,
            "analyzedCount": analyzed,
            "pendingCount": pending,
            "rows": [
                {
                    "topicId": r["topic_id"],
                    "title": r["title"],
                    "url": r["url"],
                    "firstSeenTs": r["first_seen_ts"],
                    "seeded": bool(r["seeded"]),
                    "author": r["author"],
                    "postedAt": r["posted_at"],
                    "analysisStatus": r["analysis_status"],
                    "analysis": json.loads(r["analysis_json"]) if r["analysis_json"] else None,
                    "analysisTs": r["analysis_ts"],
                    "analysisError": (r["analysis_error"] or None) if r["analysis_status"] == "failed" else None,
                }
                for r in rows
            ],
        }
        os.makedirs(os.path.dirname(EXPORT_PATH), exist_ok=True)
        tmp = f"{EXPORT_PATH}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o644)
        os.replace(tmp, EXPORT_PATH)


def migrate_cp1252(conn):
    """一次性修正早期按 latin-1 解错的标题/楼主/正文(含 C1 控制字符的行)"""
    n = 0
    for row in conn.execute("SELECT topic_id,title,author,post_text FROM posts").fetchall():
        fixed = (fix_cp1252(row["title"]), fix_cp1252(row["author"]), fix_cp1252(row["post_text"]))
        if fixed != (row["title"], row["author"], row["post_text"]):
            conn.execute("UPDATE posts SET title=?, author=?, post_text=? WHERE topic_id=?", (*fixed, row["topic_id"]))
            n += 1
    conn.commit()
    if n:
        log(f"修正 {n} 条 cp1252 乱码(标题/楼主/正文)")
        event(conn, "migrate_cp1252", f"fixed={n}")


def refresh_titles(conn, topics):
    """板块页上仍在的帖子:标题被楼主改了就跟着改"""
    changed = 0
    for tid, title, url, pinned in topics:
        cur = conn.execute("UPDATE posts SET title=? WHERE topic_id=? AND title<>?", (title, tid, title))
        changed += cur.rowcount
    if changed:
        conn.commit()
        log(f"同步 {changed} 条标题变更")


# ---------- 主循环 ----------
def main():
    conn = open_db()
    last_id_raw = meta_get(conn, "last_id")
    last_id = int(float(last_id_raw)) if last_id_raw else None
    log("监控启动,起始 topic_id = " + ("(首次)" if last_id is None else str(last_id)))
    log(f"推送: TG={'on' if TG_TOKEN and TG_CHAT else 'off'} 微信={'on' if PUSHPLUS_TOKEN else 'off'} 速览={'on' if ANALYSIS_ENABLED else 'off'}({GROK_MODEL})")
    fail_streak = int(meta_get(conn, "fail_streak", 0) or 0)
    migrate_cp1252(conn)
    export_json(conn)

    if ANALYSIS_ENABLED:
        threading.Thread(target=analysis_worker, name="analysis", daemon=True).start()

    while not stop_event.is_set():
        try:
            topics = fetch_topics()
            fail_streak = 0
            meta_set(conn, "fail_streak", 0)
            meta_set(conn, "last_error", None)
            ts = now_ms()
            meta_set(conn, "last_check_ts", ts)
            meta_set(conn, "last_ok_ts", ts)

            if last_id is None:
                # 首次启动:只记基准,不推送;基准页上的帖子也入库(标 seeded),让网站一上来有东西看
                last_id = max((t[0] for t in topics), default=0)
                status = "pending" if SEED_ANALYZE else "skipped"
                for tid, title, url, pinned in topics:
                    if pinned:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO posts(topic_id,title,url,first_seen_ts,seeded,analysis_status) VALUES(?,?,?,?,1,?)",
                        (tid, title, url, ts, status))
                conn.commit()
                meta_set(conn, "last_id", last_id)
                event(conn, "seed", f"baseline={last_id} topics={len(topics)}")
                log(f"首次启动,基准 topic_id = {last_id},本页 {len(topics)} 帖不推送(已入库标 seeded)")
                export_json(conn)
                stop_event.wait(CHECK_EVERY_SEC)
                continue

            refresh_titles(conn, topics)
            new_items = [(tid, title, url) for tid, title, url, pinned in topics
                         if tid > last_id and not pinned]
            new_items.sort(key=lambda x: x[0])

            if new_items:
                for tid, title, url in new_items:
                    log(f"新帖: {title} | {url}")
                    conn.execute(
                        "INSERT OR IGNORE INTO posts(topic_id,title,url,first_seen_ts,seeded,analysis_status) VALUES(?,?,?,?,0,?)",
                        (tid, title, url, ts, "pending" if ANALYSIS_ENABLED else "skipped"))
                    conn.commit()
                    ok = tg_send(title, url)
                    conn.execute("UPDATE posts SET pushed_tg=? WHERE topic_id=?", (1 if ok else 0, tid))
                    conn.commit()
                    event(conn, "new_post", f"#{tid} {title[:120]} tg={'ok' if ok else 'fail'}")
                last_id = new_items[-1][0]
                meta_set(conn, "last_id", last_id)
                ok = wechat_send([(t, u) for _, t, u in new_items])
                conn.execute("UPDATE posts SET pushed_wx=? WHERE topic_id IN (%s)" % ",".join("?" * len(new_items)),
                             [1 if ok else 0] + [tid for tid, _, _ in new_items])
                conn.commit()
                export_json(conn)
            else:
                export_json(conn)

        except Exception as e:
            fail_streak += 1
            meta_set(conn, "fail_streak", fail_streak)
            meta_set(conn, "last_error", str(e)[:500])
            meta_set(conn, "last_check_ts", now_ms())
            log(f"本轮抓取失败({fail_streak}连败): {e}")
            event(conn, "fetch_failed", f"streak={fail_streak} {str(e)[:300]}")
            if fail_streak in (10, 60):
                wechat_send([(f"监控异常: 已连续失败{fail_streak}次,最新错误 {e}", BOARD_URL)])
            try:
                export_json(conn)
            except Exception:
                pass

        # 连续失败逐步退避,最长10分钟,防止封IP也防止日志刷屏
        stop_event.wait(min(CHECK_EVERY_SEC * (1 + fail_streak // 3), 600))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("手动退出")
    except Exception:
        log("致命错误:\n" + traceback.format_exc())
        sys.exit(1)
