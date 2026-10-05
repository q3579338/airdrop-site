#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""名人 / 政客发币新闻监控 —— 服务器版。

目的:LAPTOP 是 WSJ 提前两天报的,空投名单按 Substack 订阅者截;要吃这种空投,靠的是「消息出来当天就去订阅」。
这个进程盯新闻,一有「某某(名人)计划/宣布发币」的报道就推微信 + Telegram,并在 airdrop.satloot.com/celeb/ 存档。

数据源(全部 RSS,无需 key):
  * Google News RSS 的几组检索(覆盖 WSJ、CoinDesk、Forbes、The Hill 等所有被 Google 收录的媒体);
  * The Block / CoinDesk / Cointelegraph / Decrypt 的站点 RSS(比 Google 收录快几分钟到几小时)。
命中规则(标题 + 摘要):
  发币动词(launch / launches / to launch / debuts / unveils / announces / plans / teases / airdrop …)
  且 代币词(memecoin / meme coin / token / crypto coin / $TICKER …)
  且 人物信号:watchlist.json 点名(强命中)或 身份词(celebrity / rapper / senator / president / politician / influencer …,弱命中)。
去重:同一人物(或同一 $TICKER)7 天内算同一个「事件」,只在第一篇推送;后续报道只累加 mentions,页面上显示报道数。
推送:微信 PushPlus(令牌只发给令牌主人本人,不带 topic)+ Telegram;首次启动只记基准不推送。
速览:后台线程交给 grok 生成中文结构化速览(谁、什么币、哪条链、什么时候、空投规则、去哪订阅、可信度、评分)。
配置全部走环境变量;推送令牌沿用 /etc/btt-monitor.env 里的 BTT_*(CELEB_* 存在则优先)。
"""
import argparse
import hashlib
import html
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
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))


# grok 周配额用完(402)时切 codex(ChatGPT 订阅)接着跑;共用模块在仓库根 lib/
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import ai_fallback  # noqa: E402


def env(name, default=""):
    """CELEB_* 优先,其次同名 BTT_*(推送令牌、grok 配置与 BTT 监控共用)"""
    v = os.environ.get("CELEB_" + name)
    if v is None or v == "":
        v = os.environ.get("BTT_" + name, default)
    return (v or "").strip()


# ---------- 配置 ----------
TG_TOKEN = env("TG_TOKEN")
TG_CHAT = env("TG_CHAT")
PUSHPLUS_TOKEN = env("PUSHPLUS_TOKEN")
CHECK_EVERY_SEC = int(os.environ.get("CELEB_CHECK_EVERY_SEC", "600"))
DB_PATH = os.environ.get("CELEB_DB", "/var/lib/celeb-monitor/celeb.sqlite")
EXPORT_PATH = os.environ.get("CELEB_EXPORT", "/var/lib/celeb-monitor/export.json")
EXPORT_LIMIT = int(os.environ.get("CELEB_EXPORT_LIMIT", "300"))
WATCHLIST_PATH = os.environ.get("CELEB_WATCHLIST", os.path.join(HERE, "watchlist.json"))
ANALYSIS_ENABLED = os.environ.get("CELEB_ANALYSIS", "1") != "0"
SEED_ANALYZE = os.environ.get("CELEB_SEED_ANALYZE", "1") != "0"
PUSH_WEAK = os.environ.get("CELEB_PUSH_WEAK", "1") != "0"  # 身份词弱命中是否也推送
GROK_BIN = env("GROK_BIN", "grok")
GROK_MODEL = env("GROK_MODEL", "grok-4.5")
GROK_TIMEOUT_SEC = int(env("GROK_TIMEOUT_SEC", "240"))
GROK_PROXY = env("GROK_PROXY")
HTTP_PROXY = os.environ.get("CELEB_HTTP_PROXY", "").strip()  # RSS 出网代理;留空 = 直连(服务器直连没问题)
ANALYSIS_MAX_TRIES = 3
STORY_WINDOW_DAYS = 7
CST = timezone(timedelta(hours=8))

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"})
if HTTP_PROXY:
    session.proxies.update({"http": HTTP_PROXY, "https": HTTP_PROXY})

export_lock = threading.Lock()
stop_event = threading.Event()


def now_ms():
    return int(time.time() * 1000)


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


# ---------- 数据源 ----------
def gnews(q):
    return "https://news.google.com/rss/search?q=" + quote_plus(q) + "&hl=en-US&gl=US&ceid=US:en"


FEEDS = [
    ("gnews:memecoin", gnews('"memecoin" (launch OR launches OR launching OR debuts OR unveils OR announces OR airdrop) when:2d')),
    ("gnews:meme-coin", gnews('"meme coin" (launch OR launches OR launching OR debuts OR unveils OR announces OR airdrop) when:2d')),
    ("gnews:celebrity-token", gnews('(celebrity OR rapper OR senator OR president OR politician OR influencer OR billionaire OR actor OR singer) ("own token" OR "own cryptocurrency" OR "crypto token" OR "meme token" OR "launch a token" OR "launching a token" OR "token launch") when:2d')),
    ("gnews:coin-named", gnews('("coin named" OR "token named" OR "memecoin named" OR "cryptocurrency named") when:2d')),
    ("theblock", "https://www.theblock.co/rss.xml"),
    ("coindesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("cointelegraph", "https://cointelegraph.com/rss"),
    ("decrypt", "https://decrypt.co/feed"),
]

# ---------- 命中规则 ----------
LAUNCH_RE = re.compile(
    r"\b(launch(?:es|ed|ing)?|to launch|debut(?:s|ed)?|unveil(?:s|ed)?|announc(?:es|ed|ing)|plans?|planning|tease(?:s|d)?|"
    r"roll(?:s|ed)? out|releas(?:es|ed|ing)|drop(?:s|ped)?|introduc(?:es|ed)|issu(?:es|ed|ing)|mint(?:s|ed)?|airdrop(?:s|ped)?|"
    r"enters? (?:the )?crypto|goes crypto|jumps into crypto|gets? (?:a|its own) (?:coin|token))\b", re.I)
TOKEN_RE = re.compile(
    r"(\bmeme ?coins?\b|\bmeme tokens?\b|\btokens?\b|\bcryptocurrency\b|\bcrypto coins?\b|\bcoin\b|\$[A-Z]{2,10}\b|\bairdrops?\b|\bnft\b)", re.I)
ROLE_RE = re.compile(
    r"\b(celebrit(?:y|ies)|rapper|singer|actor|actress|athlete|boxer|footballer|fighter|senator|congress(?:man|woman)|governor|"
    r"mayor|president(?:'s)?|prime minister|politician|lawmaker|first lady|influencer|youtuber|streamer|podcaster|billionaire|"
    r"tycoon|mogul|founder of|ceo of|son of|daughter of|wife of|husband of|royal|prince|princess|pop star|movie star|tv star|"
    r"reality star|host|comedian|musician|dj|k-pop|idol)\b", re.I)
# 排除:讲已有币价格涨跌、分析类的标题,不是「谁要发币」
NOISE_RE = re.compile(
    r"\b(price prediction|price analysis|technical analysis|whale|rally|rallies|surges?|soars?|plunges?|crash(?:es|ed)?|"
    r"dips?|dumps?|pumps?|market cap|trading volume|top \d+|best (?:meme|crypto)|presale (?:round|stage)|"
    r"how to buy|should you buy|is it too late|next 100x|\d+x)\b", re.I)
TICKER_RE = re.compile(r"\$([A-Z]{2,10})\b")


def load_watchlist():
    try:
        with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        people = []
        for p in data.get("people", []):
            aliases = [a.lower().strip() for a in p.get("aliases", []) if a.strip()]
            if not aliases:
                continue
            pat = re.compile(r"(?<![a-z0-9])(" + "|".join(re.escape(a) for a in aliases) + r")(?![a-z0-9])", re.I)
            people.append({"name": p.get("name") or aliases[0], "re": pat, "subscribe": p.get("subscribe", "")})
        return people
    except Exception as e:
        log(f"watchlist 读取失败({WATCHLIST_PATH}): {e}")
        return []


WATCHLIST = load_watchlist()


def strip_html(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def classify(title, summary):
    """返回 (level, person, ticker, subscribe) ;level: 'strong' 点名 / 'weak' 身份词 / None 不命中"""
    text = f"{title} {summary}"
    if NOISE_RE.search(title) and not any(p["re"].search(title) for p in WATCHLIST):
        return None, None, None, None
    if not LAUNCH_RE.search(text) or not TOKEN_RE.search(text):
        return None, None, None, None
    m = TICKER_RE.search(text)
    ticker = m.group(1) if m else None
    for p in WATCHLIST:
        if p["re"].search(text):
            return "strong", p["name"], ticker, p["subscribe"]
    if ROLE_RE.search(text):
        # 弱命中:从标题里猜一个人名(连续两个首字母大写的词,排除句首常见词)
        person = guess_person(title)
        return "weak", person, ticker, ""
    return None, None, None, None


STOP_CAP = {"The", "A", "An", "This", "That", "New", "Why", "How", "What", "When", "Where", "Who", "Exclusive", "Report", "Breaking",
            "Just", "In", "On", "Of", "For", "And", "Or", "But", "With", "From", "To", "As", "At", "By", "Is", "Are", "Was", "Were",
            "Meme", "Memecoin", "Coin", "Token", "Crypto", "Cryptocurrency", "Bitcoin", "Ethereum", "Solana", "Base", "Launch",
            "Launches", "Launching", "Airdrop", "Trump", "Biden", "President", "Senator", "Celebrity"}


ROLE_CAP = {"Boxer", "Rapper", "Singer", "Actor", "Actress", "Senator", "Governor", "Mayor", "President", "Influencer", "Youtuber",
            "Streamer", "Podcaster", "Billionaire", "Comedian", "Musician", "Athlete", "Footballer", "Fighter", "Host", "Star"}


def guess_person(title):
    """标题里连续 2–3 个首字母大写的词;去掉开头的身份词(Boxer/Singer…)和结尾的 To/In 之类"""
    for m in re.finditer(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b", title):
        words = m.group(1).split()
        while words and (words[0] in ROLE_CAP or words[0] in STOP_CAP):
            words = words[1:]
        while words and words[-1] in STOP_CAP:
            words = words[:-1]
        if len(words) >= 2:
            return " ".join(words[:3])
    return None


# ---------- SQLite ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_key TEXT NOT NULL,
  level TEXT NOT NULL,
  person TEXT,
  ticker TEXT,
  subscribe TEXT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT,
  published_ts INTEGER,
  first_seen_ts INTEGER NOT NULL,
  last_seen_ts INTEGER NOT NULL,
  mentions INTEGER NOT NULL DEFAULT 1,
  seeded INTEGER NOT NULL DEFAULT 0,
  pushed_tg INTEGER NOT NULL DEFAULT 0,
  pushed_wx INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  analysis_json TEXT,
  analysis_raw TEXT,
  analysis_ts INTEGER,
  analysis_error TEXT,
  analysis_tries INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stories_key ON stories(story_key, last_seen_ts);
CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(analysis_status);
CREATE TABLE IF NOT EXISTS articles (
  url_hash TEXT PRIMARY KEY,
  story_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source TEXT,
  published_ts INTEGER,
  seen_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_id);
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


# ---------- 推送 ----------
def tg_escape(text):
    return re.sub(r"([_*\[\]()~`>#+\-=|{}.!<])", r"\\\1", text)


def tg_send(text_md):
    if not TG_TOKEN or not TG_CHAT:
        return False
    for _ in range(3):
        try:
            r = session.post(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
                             data={"chat_id": TG_CHAT, "text": text_md, "parse_mode": "MarkdownV2", "disable_web_page_preview": True},
                             timeout=30)
            if r.ok:
                return True
            log(f"TG返回异常: {r.status_code} {r.text[:200]}")
        except requests.RequestException as e:
            log(f"TG发送失败: {e}")
        time.sleep(2)
    return False


def wechat_send(title, content_md):
    """PushPlus 不带 topic:只发给令牌主人自己的微信"""
    if not PUSHPLUS_TOKEN:
        return False
    for _ in range(3):
        try:
            r = session.post("https://www.pushplus.plus/send",
                             json={"token": PUSHPLUS_TOKEN, "title": title[:100], "content": content_md, "template": "markdown"},
                             timeout=30)
            if r.ok:
                return True
            log(f"PushPlus返回异常: {r.status_code} {r.text[:200]}")
        except requests.RequestException as e:
            log(f"微信推送失败: {e}")
        time.sleep(2)
    return False


def story_line(s):
    who = s["person"] or "未识别人物"
    tk = f" ${s['ticker']}" if s.get("ticker") else ""
    lvl = "点名" if s["level"] == "strong" else "疑似"
    return who, tk, lvl


def push_story(conn, s):
    who, tk, lvl = story_line(s)
    sub = s.get("subscribe") or ""
    # Telegram:一条一事件
    tg_text = f"*名人发币 {tg_escape(lvl)}*: {tg_escape(who + tk)}\n[{tg_escape(s['title'])}]({s['url']})"
    if sub:
        tg_text += f"\n去订阅: {tg_escape(sub)}"
    ok_tg = tg_send(tg_text)
    # 微信:一条一事件(事件本来就少)
    wx_title = f"名人发币{lvl}: {who}{tk}"
    wx_body = f"**{s['title']}**\n\n来源 {s.get('source') or '?'}\n\n[{s['url']}]({s['url']})"
    if sub:
        wx_body += f"\n\n**现在去订阅**: {sub}"
    wx_body += "\n\n先订阅再研究,名单一般按报道后几天内截。只认官方渠道,不连钱包。"
    ok_wx = wechat_send(wx_title, wx_body)
    conn.execute("UPDATE stories SET pushed_tg=?, pushed_wx=? WHERE id=?", (1 if ok_tg else 0, 1 if ok_wx else 0, s["id"]))
    conn.commit()
    event(conn, "push", f"#{s['id']} {who}{tk} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")
    return ok_tg, ok_wx


# ---------- 抓 RSS ----------
def parse_feed(name, url):
    r = session.get(url, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for it in root.iter("item"):
        title = strip_html(it.findtext("title") or "")
        link = (it.findtext("link") or "").strip()
        if not title or not link:
            continue
        desc = strip_html(it.findtext("description") or "")[:600]
        src_el = it.find("source")
        source = strip_html(src_el.text) if src_el is not None and src_el.text else name
        pub = it.findtext("pubDate") or ""
        try:
            pts = int(parsedate_to_datetime(pub).timestamp() * 1000)
        except Exception:
            pts = None
        # Google News 标题末尾带 " - 媒体名",拆出来
        if name.startswith("gnews") and " - " in title:
            t2, _, s2 = title.rpartition(" - ")
            if t2 and len(s2) < 40:
                title, source = t2.strip(), s2.strip()
        items.append({"title": title, "url": link, "summary": desc, "source": source, "published_ts": pts, "feed": name})
    return items


def fetch_all():
    out, errors = [], []
    for name, url in FEEDS:
        try:
            out.extend(parse_feed(name, url))
        except Exception as e:
            errors.append(f"{name}: {str(e)[:120]}")
    if not out and errors:
        raise RuntimeError("; ".join(errors))
    return out, errors


def url_hash(u):
    return hashlib.sha1(u.encode("utf-8", "replace")).hexdigest()


def norm_key(person, ticker, title):
    if person:
        return "p:" + re.sub(r"[^a-z0-9]+", "-", person.lower()).strip("-")
    if ticker:
        return "t:" + ticker.lower()
    return "h:" + hashlib.sha1(re.sub(r"[^a-z0-9]+", " ", title.lower()).encode()).hexdigest()[:16]


# ---------- grok 速览 ----------
ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "person": {"type": "string"},
        "role": {"type": "string"},
        "token": {"type": "string"},
        "chain": {"type": "string"},
        "launch_date": {"type": "string"},
        "status": {"type": "string"},
        "airdrop": {"type": "string"},
        "subscribe": {"type": "string"},
        "credibility": {"type": "string"},
        "verdict": {"type": "string"},
        "score": {"type": "integer"},
    },
    "required": ["person", "role", "token", "chain", "launch_date", "status", "airdrop", "subscribe", "credibility", "verdict", "score"],
}
ANALYSIS_KEYS = list(ANALYSIS_SCHEMA["properties"].keys())


def build_prompt(s, articles):
    lines = "\n".join(f"- [{a['source'] or '?'}] {a['title']}" + (f" —— {a['summary']}" if a.get('summary') else "") for a in articles[:12])
    return (
        "你是加密空投猎手的助手。下面是一组新闻标题与摘要,讲的是某个名人、政客或网红计划或已经发行加密代币(memecoin)。"
        "只根据给出的内容判断,不要臆造;没提到的写「未提及」。全部用简体中文,每个字段一到两句话,不要 Markdown。字段含义:\n"
        "person 人物姓名(英文原名);role 身份(如 前总统之子、说唱歌手、参议员);token 代币名与代号;chain 所在链;"
        "launch_date 发行或计划日期;status 只能取其一:传闻 / 本人确认 / 已上线 / 已辟谣;"
        "airdrop 空投规则(给谁、按什么名单、多少比例、截止);"
        "subscribe 要想拿到空投现在该去订阅或注册什么(Substack、邮件列表、X 付费订阅、持有某币等),没提到就按人物常用渠道给出最可能的一项并注明是推测;"
        "credibility 消息可信度(WSJ/本人 X 账号 = 高,匿名爆料 = 低)与理由;verdict 一句话结论:值不值得现在去订阅;"
        "score 0 到 10 的整数,10 = 本人已确认且空投名单可提前进入,0 = 假消息或与空投无关。\n\n"
        f"识别到的人物:{s['person'] or '未识别'};代号:{s['ticker'] or '未识别'}\n"
        + (f"名单里记录的该人物常用订阅渠道(新闻没提就用它,并注明来自名单):{s['subscribe']}\n" if s.get('subscribe') else "")
        + f"\n新闻:\n{lines}\n"
    )


FALLBACK_MAX_ARTICLES = int(os.environ.get("CELEB_FALLBACK_ARTICLES", "6"))
FALLBACK_MAX_CHARS = int(os.environ.get("CELEB_FALLBACK_MAX_CHARS", "1500"))


def build_fallback_prompt(s, articles):
    """grok 耗尽时给备用(gemini / codex)用的精简版:只喂人物/代号 + 前 6 条标题(合计截到 1500 字)。

    备用每次调用光它自己的系统提示词就上万 token,新闻列表不必给满 12 条;
    输出格式交给 ai_fallback(把 ANALYSIS_SCHEMA 传下去),不用再写进提示词。
    """
    lines = "\n".join(
        ("- [%s] %s" % (a.get("source") or "?", a.get("title") or ""))
        + (" —— %s" % a["summary"] if a.get("summary") else "")
        for a in articles[:FALLBACK_MAX_ARTICLES]
    )[:FALLBACK_MAX_CHARS]
    return (
        "你是加密空投猎手的助手。下面是一组新闻标题,讲某个名人/政客/网红计划或已经发行加密代币。"
        "只根据给出的内容判断,没提到的写「未提及」,不要臆造。全部用简体中文,每字段一到两句话,不要 Markdown。\n"
        "字段:person 人物英文原名;role 身份;token 代币名与代号;chain 链;launch_date 发行或计划日期;"
        "status(传闻/本人确认/已上线/已辟谣 取其一);airdrop 空投规则;subscribe 现在该去订阅或注册什么"
        "(没提到就按该人物常用渠道给最可能的一项并注明是推测);credibility 可信度与理由;"
        "verdict 一句话结论(值不值得现在去订阅);score 0-10 整数(10 = 本人已确认且名单可提前进入)。\n\n"
        + ("人物:%s;代号:%s\n" % (s.get("person") or "未识别", s.get("ticker") or "未识别"))
        + (("名单里记录的常用订阅渠道(新闻没提就用它并注明来自名单):%s\n" % s["subscribe"]) if s.get("subscribe") else "")
        + "\n新闻:\n" + lines + "\n"
    )


def extract_json(stdout):
    s = stdout.strip()
    try:
        obj = json.loads(s)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        if all(k in obj for k in ANALYSIS_KEYS):
            return obj
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
    for m in re.finditer(r"\{[\s\S]*\}", s):
        try:
            inner = json.loads(m.group(0))
            if isinstance(inner, dict) and all(k in inner for k in ANALYSIS_KEYS):
                return inner
        except Exception:
            continue
    # 逐个左花括号 raw_decode:备用链路万一不照 --output-schema 办,会在 JSON 前后说话
    dec = json.JSONDecoder()
    found = None
    for m in re.finditer(r"\{", s):
        try:
            inner, _ = dec.raw_decode(s, m.start())
        except Exception:
            continue
        if isinstance(inner, dict) and all(k in inner for k in ANALYSIS_KEYS):
            found = inner
    if found is not None:
        return found
    raise RuntimeError("输出里没有合规 JSON: " + s[:300])


def run_grok(prompt):
    fd, path = tempfile.mkstemp(prefix="celeb-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(prompt)
    envd = dict(os.environ)
    envd["GROK_SUBAGENTS"] = "0"
    if GROK_PROXY:
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            envd[k] = GROK_PROXY
        envd["NO_PROXY"] = "localhost,127.0.0.1,::1,.local"
    argv = [GROK_BIN, "--prompt-file", path, "-m", GROK_MODEL, "--always-approve", "--no-subagents",
            "--disable-web-search", "--json-schema", json.dumps(ANALYSIS_SCHEMA, ensure_ascii=False)]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=GROK_TIMEOUT_SEC, env=envd)
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
    conn = open_db()
    log("速览线程启动")
    while not stop_event.is_set():
        row = conn.execute(
            "SELECT * FROM stories WHERE analysis_status IN ('pending','running') ORDER BY seeded ASC, id DESC LIMIT 1").fetchone()
        if row is None:
            stop_event.wait(5)
            continue
        sid = row["id"]
        conn.execute("UPDATE stories SET analysis_status='running', analysis_tries=analysis_tries+1 WHERE id=?", (sid,))
        conn.commit()
        tries = row["analysis_tries"] + 1
        try:
            arts = [dict(a) for a in conn.execute(
                "SELECT title,url,source,published_ts FROM articles WHERE story_id=? ORDER BY published_ts DESC LIMIT 12", (sid,)).fetchall()]
            if not arts:
                arts = [{"title": row["title"], "url": row["url"], "source": row["source"], "summary": row["summary"]}]
            else:
                arts[0]["summary"] = row["summary"]
            stdout, _tokens, provider = ai_fallback.ai_call(
                lambda: run_grok(build_prompt(dict(row), arts)),
                build_fallback_prompt(dict(row), arts),
                label="celeb-%s" % sid, web=False, schema=ANALYSIS_SCHEMA)
            analysis = normalize_analysis(extract_json(stdout))
            conn.execute("UPDATE stories SET analysis_status='done', analysis_json=?, analysis_raw=?, analysis_ts=?, analysis_error=NULL WHERE id=?",
                         (json.dumps(analysis, ensure_ascii=False), stdout[-4000:], now_ms(), sid))
            conn.commit()
            log(f"速览完成 #{sid} {row['person'] or row['title'][:30]} → {analysis.get('status')} / {analysis.get('score')}分 [{provider}]")
            event(conn, "analysis_done", f"#{sid} score={analysis.get('score')}")
        except Exception as e:
            err = str(e)[:800]
            status = "failed" if tries >= ANALYSIS_MAX_TRIES else "pending"
            conn.execute("UPDATE stories SET analysis_status=?, analysis_error=?, analysis_ts=? WHERE id=?", (status, err, now_ms(), sid))
            conn.commit()
            log(f"速览失败 #{sid}(第 {tries} 次): {err[:200]}")
            event(conn, "analysis_failed", f"#{sid} try={tries} {err[:300]}")
            if status == "pending":
                stop_event.wait(20)
        export_json(conn)


# ---------- 导出给网站 ----------
def export_json(conn):
    with export_lock:
        rows = conn.execute("SELECT * FROM stories ORDER BY last_seen_ts DESC, id DESC LIMIT ?", (EXPORT_LIMIT,)).fetchall()
        today_start = datetime.now(CST).replace(hour=0, minute=0, second=0, microsecond=0)
        today_ms = int(today_start.timestamp() * 1000)
        total = conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0]
        strong = conn.execute("SELECT COUNT(*) FROM stories WHERE level='strong'").fetchone()[0]
        analyzed = conn.execute("SELECT COUNT(*) FROM stories WHERE analysis_status='done'").fetchone()[0]
        today_count = conn.execute("SELECT COUNT(*) FROM stories WHERE first_seen_ts>=? AND seeded=0", (today_ms,)).fetchone()[0]
        pending = conn.execute("SELECT COUNT(*) FROM stories WHERE analysis_status IN ('pending','running')").fetchone()[0]
        articles_total = conn.execute("SELECT COUNT(*) FROM articles").fetchone()[0]

        def iso(ms):
            return None if ms is None else datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()

        out_rows = []
        for r in rows:
            arts = conn.execute("SELECT title,url,source,published_ts FROM articles WHERE story_id=? ORDER BY published_ts DESC LIMIT 8",
                                (r["id"],)).fetchall()
            out_rows.append({
                "id": r["id"],
                "storyKey": r["story_key"],
                "level": r["level"],
                "person": r["person"],
                "ticker": r["ticker"],
                "subscribe": r["subscribe"],
                "title": r["title"],
                "url": r["url"],
                "source": r["source"],
                "summary": r["summary"],
                "publishedTs": r["published_ts"],
                "firstSeenTs": r["first_seen_ts"],
                "lastSeenTs": r["last_seen_ts"],
                "mentions": r["mentions"],
                "seeded": bool(r["seeded"]),
                "pushedWx": bool(r["pushed_wx"]),
                "analysisStatus": r["analysis_status"],
                "analysis": json.loads(r["analysis_json"]) if r["analysis_json"] else None,
                "analysisTs": r["analysis_ts"],
                "analysisError": (r["analysis_error"] or None) if r["analysis_status"] == "failed" else None,
                "articles": [{"title": a["title"], "url": a["url"], "source": a["source"], "publishedTs": a["published_ts"]} for a in arts],
            })
        data = {
            "generatedAt": iso(now_ms()),
            "lastCheckAt": iso(meta_get(conn, "last_check_ts")),
            "lastOkAt": iso(meta_get(conn, "last_ok_ts")),
            "lastError": meta_get(conn, "last_error"),
            "failStreak": int(meta_get(conn, "fail_streak", 0) or 0),
            "checkEverySec": CHECK_EVERY_SEC,
            "feeds": [n for n, _ in FEEDS],
            "watchlist": [p["name"] for p in WATCHLIST],
            "count": total,
            "strongCount": strong,
            "todayCount": today_count,
            "analyzedCount": analyzed,
            "pendingCount": pending,
            "articleCount": articles_total,
            "rows": out_rows,
        }
        os.makedirs(os.path.dirname(EXPORT_PATH), exist_ok=True)
        tmp = f"{EXPORT_PATH}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o644)
        os.replace(tmp, EXPORT_PATH)


# ---------- 一轮处理 ----------
def process_items(conn, items, seeding, dry=False):
    """把抓到的条目归入事件;返回本轮新建的事件列表(seeding 时也建但标 seeded)"""
    ts = now_ms()
    window_ms = STORY_WINDOW_DAYS * 86400 * 1000
    new_stories = []
    seen_urls = set()
    # 按发布时间正序处理,让最早的报道成为事件主条目
    items = sorted(items, key=lambda x: x.get("published_ts") or 0)
    for it in items:
        h = url_hash(it["url"])
        if h in seen_urls:
            continue
        seen_urls.add(h)
        if conn.execute("SELECT 1 FROM articles WHERE url_hash=?", (h,)).fetchone():
            continue
        level, person, ticker, subscribe = classify(it["title"], it["summary"])
        if level is None:
            continue
        key = norm_key(person, ticker, it["title"])
        story = conn.execute("SELECT * FROM stories WHERE story_key=? AND last_seen_ts>=? ORDER BY id DESC LIMIT 1",
                             (key, ts - window_ms)).fetchone()
        if dry:
            log(f"  [{level}] {person or '?'} ${ticker or '-'} | {it['source']} | {it['title'][:90]}")
            continue
        if story is None:
            cur = conn.execute(
                "INSERT INTO stories(story_key,level,person,ticker,subscribe,title,url,source,published_ts,first_seen_ts,last_seen_ts,mentions,seeded,summary,analysis_status)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
                (key, level, person, ticker, subscribe, it["title"], it["url"], it["source"], it["published_ts"], ts, ts,
                 1 if seeding else 0, it["summary"],
                 "pending" if ANALYSIS_ENABLED and (not seeding or SEED_ANALYZE) else "skipped"))
            sid = cur.lastrowid
            conn.execute("INSERT INTO articles(url_hash,story_id,title,url,source,published_ts,seen_ts) VALUES(?,?,?,?,?,?,?)",
                         (h, sid, it["title"], it["url"], it["source"], it["published_ts"], ts))
            conn.commit()
            new_stories.append(conn.execute("SELECT * FROM stories WHERE id=?", (sid,)).fetchone())
            log(f"{'基准' if seeding else '新事件'} [{level}] {person or '?'}{' $' + ticker if ticker else ''} | {it['source']} | {it['title'][:90]}")
        else:
            sid = story["id"]
            # 点名命中升级弱命中;补 ticker / 订阅提示
            upd = {"last_seen_ts": ts, "mentions": story["mentions"] + 1}
            if level == "strong" and story["level"] != "strong":
                upd.update({"level": "strong", "person": person, "subscribe": subscribe})
            if ticker and not story["ticker"]:
                upd["ticker"] = ticker
            sets = ", ".join(f"{k}=?" for k in upd)
            conn.execute(f"UPDATE stories SET {sets} WHERE id=?", [*upd.values(), sid])
            conn.execute("INSERT INTO articles(url_hash,story_id,title,url,source,published_ts,seen_ts) VALUES(?,?,?,?,?,?,?)",
                         (h, sid, it["title"], it["url"], it["source"], it["published_ts"], ts))
            conn.commit()
    return new_stories


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="抓一轮,打印命中,不入库不推送(本地验证规则用)")
    ap.add_argument("--seed-only", action="store_true", help="只做一轮基准入库并导出 export.json 后退出(生成本地 fixture 用)")
    args = ap.parse_args()

    if args.once:
        items, errors = fetch_all()
        log(f"抓到 {len(items)} 条,源错误: {errors or '无'}")
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(SCHEMA)
        process_items(conn, items, seeding=False, dry=True)
        return

    conn = open_db()
    seeded = meta_get(conn, "seeded") == "1"
    if args.seed_only:
        items, errors = fetch_all()
        ts = now_ms()
        meta_set(conn, "last_check_ts", ts)
        meta_set(conn, "last_ok_ts", ts)
        new_stories = process_items(conn, items, seeding=not seeded)
        meta_set(conn, "seeded", "1")
        export_json(conn)
        log(f"seed-only: {len(items)} 条 → {len(new_stories)} 个事件,导出 {EXPORT_PATH}")
        return
    log(f"监控启动: watchlist {len(WATCHLIST)} 人, 源 {len(FEEDS)} 个, 每 {CHECK_EVERY_SEC}s 一轮, 基准{'已' if seeded else '未'}建立")
    log(f"推送: TG={'on' if TG_TOKEN and TG_CHAT else 'off'} 微信={'on' if PUSHPLUS_TOKEN else 'off'} 速览={'on' if ANALYSIS_ENABLED else 'off'}({GROK_MODEL}) 弱命中推送={'on' if PUSH_WEAK else 'off'}")
    fail_streak = int(meta_get(conn, "fail_streak", 0) or 0)
    export_json(conn)
    if ANALYSIS_ENABLED:
        threading.Thread(target=analysis_worker, name="analysis", daemon=True).start()

    while not stop_event.is_set():
        try:
            items, errors = fetch_all()
            fail_streak = 0
            meta_set(conn, "fail_streak", 0)
            meta_set(conn, "last_error", "; ".join(errors) if errors else None)
            ts = now_ms()
            meta_set(conn, "last_check_ts", ts)
            meta_set(conn, "last_ok_ts", ts)
            new_stories = process_items(conn, items, seeding=not seeded)
            if not seeded:
                seeded = True
                meta_set(conn, "seeded", "1")
                event(conn, "seed", f"stories={len(new_stories)} items={len(items)}")
                log(f"首次启动:{len(new_stories)} 个事件作为基准入库,不推送")
            else:
                for s in new_stories:
                    if s["level"] == "weak" and not PUSH_WEAK:
                        continue
                    push_story(conn, s)
            export_json(conn)
        except Exception as e:
            fail_streak += 1
            meta_set(conn, "fail_streak", fail_streak)
            meta_set(conn, "last_error", str(e)[:500])
            meta_set(conn, "last_check_ts", now_ms())
            log(f"本轮抓取失败({fail_streak}连败): {e}")
            event(conn, "fetch_failed", f"streak={fail_streak} {str(e)[:300]}")
            if fail_streak in (10, 60):
                wechat_send("名人发币监控异常", f"已连续失败 {fail_streak} 次,最新错误:{e}")
            try:
                export_json(conn)
            except Exception:
                pass
        stop_event.wait(min(CHECK_EVERY_SEC * (1 + fail_streak // 3), 1800))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("手动退出")
    except Exception:
        log("致命错误:\n" + traceback.format_exc())
        sys.exit(1)
