#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NFT 打新机会追踪 —— 服务器版。

目的:NFT 白名单 / mint 的窗口很短,KOL 推一波之后,阶段、铸造时间、价格随时会改(例:Kokomoji 官网写 0.033 ETH,之后推文改价)。
这个进程替人盯着:名单里的项目定时核查,一变就推微信 + Telegram;铸造前 24 小时 / 1 小时各提醒一次;再定期在 X 上找新机会。

数据来源:grok 联网(X 搜索 + 网页)。服务器上 grok 的 --json-schema 与联网工具不兼容(工具旁白会混进输出),
所以这里用 --output-format json 拿纯文本,再从文本里抠出最后一个合规 JSON 对象。
  * 名单:nft/watchlist.json(人工录入的初始资料 + KOL 观点出处),文件改了自动同步;
  * 核查:每个项目一次 grok 联网调用(实测 1.5–2.5 分钟),名单项目默认 3 小时一次,AI 发现的 12 小时一次,
    铸造前 48 小时内加密到 30 分钟,已上市 / 已售罄 / 取消的放慢到 24 小时;设了 NFT_DAILY_BUDGET_USD 才有每日花费上限;
  * 变动:阶段、铸造时间(差 1 小时以上)、铸造价、总量、单钱包上限 —— 与上次比较,有变就推送;每个项目的第一次核查只做基准;
    AI 这次没查到(未公布)的字段沿用上次的值,不当成变动;
  * 发现:默认 3 小时让 grok 在 X 上找最多 8 个新的白名单 / mint 机会,新账号入库为「AI 发现」并合并推一条;第一次发现只做基准。
推送:微信 PushPlus(不带 topic,只发令牌主人本人)+ Telegram;所有提醒带当时价格(铸造价 + ETH 现价)。
落库:SQLite(projects / snapshots / changes / meta / events),export.json 原子导出给 airdrop.satloot.com/nft/。
配置走环境变量;推送令牌与 grok 配置沿用 /etc/btt-monitor.env 的 BTT_*(NFT_* 存在则优先)。
"""
import argparse
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

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))

# grok 周配额耗尽时 NFT 追踪直接暂停,不走 codex 备用(用户 09-20:联网核查每次约 5 万 token,
# 备用只给 BTT 速览和空投雷达用)。这里只读共用标记 + 帮着把自己撞到的 402 记进去。
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "lib"))
import ai_fallback  # noqa: E402


def env(name, default=""):
    """NFT_* 优先,其次同名 BTT_*(推送令牌、grok 配置与 BTT 监控共用)"""
    v = os.environ.get("NFT_" + name)
    if v is None or v == "":
        v = os.environ.get("BTT_" + name, default)
    return (v or "").strip()


# ---------- 配置 ----------
TG_TOKEN = env("TG_TOKEN")
TG_CHAT = env("TG_CHAT")
PUSHPLUS_TOKEN = env("PUSHPLUS_TOKEN")
# grok 按周配额(SuperGrok),NFT 联网核查每次约 5 万 token:09-16 实测一天 187 次 ≈ 周配额 42%。
# 用户 09-16 明确"不要关闭,用完了我会换号"——所以保持高频,不设日上限;配额见底时换 grok 账号(见 README)
# 核查节奏按项目状态分档(09-16 用户要求):有日程的盯紧,没消息的少查,项目数量不设上限。
# 查十次结果都一样的尾部小盘最费配额,分档后同样的覆盖面只要三分之一的调用
# 09-16 用户:"项目不用频繁验证,找到了就行"——发现保持 2 小时一轮,核查整体放慢,只给已申请项目留铸造精度
SPRINT_TRACK_EVERY_SEC = int(os.environ.get("NFT_SPRINT_TRACK_EVERY_SEC", "900"))    # 已申请项目的铸造当天 15min(FCFS 名额靠手快)
APPLIED_NEAR_TRACK_EVERY_SEC = int(os.environ.get("NFT_APPLIED_NEAR_TRACK_EVERY_SEC", "3600"))  # 已申请项目铸造前后 1h
APPLIED_MAX_TRACK_EVERY_SEC = int(os.environ.get("NFT_APPLIED_MAX_TRACK_EVERY_SEC", "43200"))  # 已申请项目最长多久必查一次(12h)
NEAR_TRACK_EVERY_SEC = int(os.environ.get("NFT_NEAR_TRACK_EVERY_SEC", "14400"))     # 名单项目铸造前后 4h(AI 发现的不进这档)
DATED_TRACK_EVERY_SEC = int(os.environ.get("NFT_DATED_TRACK_EVERY_SEC", "86400"))   # 已公布铸造日期(未来)12h
WL_TRACK_EVERY_SEC = int(os.environ.get("NFT_WL_TRACK_EVERY_SEC", "259200"))         # 白名单申请中 24h
MINTING_TRACK_EVERY_SEC = int(os.environ.get("NFT_MINTING_TRACK_EVERY_SEC", "7200"))  # 实测每次核查约吃周配额 0.4%,一天 35 次≈14%  # 正在铸造 2h(状态最短命,卖完就没了)
QUIET_TRACK_EVERY_SEC = int(os.environ.get("NFT_QUIET_TRACK_EVERY_SEC", "604800"))  # 预热 / 没有明确日程 48h
ENDED_TRACK_EVERY_SEC = int(os.environ.get("NFT_ENDED_TRACK_EVERY_SEC", "604800"))  # 已售罄 / 已上市 / 取消 7 天
DISCOVERED_FACTOR = float(os.environ.get("NFT_DISCOVERED_FACTOR", "24"))            # AI 发现的项目在以上基础上乘这个系数
DISCOVER_EVERY_SEC = int(os.environ.get("NFT_DISCOVER_EVERY_SEC", "43200"))
DISCOVER_MAX_NEW = int(os.environ.get("NFT_DISCOVER_MAX_NEW", "2"))       # 每轮最多收几个新项目
DISCOVER_MAX_URGENT = int(os.environ.get("NFT_DISCOVER_MAX_URGENT", "2"))  # 其中最多几个立刻核查(09-16:Arc 主网日 AI 把 8 个全标成今天开铸)
# 新发现的项目:只有线索说「正在铸造 / 今明两天开铸」的才立刻核查并推送,其余排到 12 小时后慢慢补
# (09-16:每轮 8 个全部立刻核查 = 一天最多 192 次首查,是配额大头)
DISCOVERED_FIRST_DELAY_SEC = int(os.environ.get("NFT_DISCOVERED_FIRST_DELAY_SEC", "43200"))
DISCOVER_ENABLED = os.environ.get("NFT_DISCOVER", "1") != "0"
DISCOVER_MAX_ACTIVE = int(os.environ.get("NFT_DISCOVER_MAX_ACTIVE", "0"))           # 0 = 不限项目数(用户 09-16 要求)
DAILY_BUDGET_USD = float(os.environ.get("NFT_DAILY_BUDGET_USD", "0"))  # 北京时间自然日名义花费上限;默认 0 = 不限(需要临时省配额时再设)
DB_PATH = os.environ.get("NFT_DB", "/var/lib/nft-monitor/nft.sqlite")
EXPORT_PATH = os.environ.get("NFT_EXPORT", "/var/lib/nft-monitor/export.json")
WATCHLIST_PATH = os.environ.get("NFT_WATCHLIST", os.path.join(HERE, "watchlist.json"))
GROK_BIN = env("GROK_BIN", "grok")
GROK_MODEL = env("GROK_MODEL", "grok-4.5")
GROK_TIMEOUT_SEC = max(int(env("GROK_TIMEOUT_SEC", "360") or 360), 360)  # 联网检索比纯文本速览慢,至少给 6 分钟
GROK_MAX_TURNS = int(os.environ.get("NFT_GROK_MAX_TURNS", "14"))  # 限制搜索轮数,单次调用的 token 直接少一截
GROK_PROXY = env("GROK_PROXY")
PAGE_URL = "https://airdrop.satloot.com/nft/"
# 站主自己参与的项目:仓库根 participation.json 里 section=nft 的 handle(网站右侧「参与表」同一份),
# 外加可选 env NFT_MY_APPLIED(逗号分隔,放不想公开的);推送加「已申请」,铸造日前后加密核查与提醒
PARTICIPATION_PATH = os.environ.get("NFT_PARTICIPATION", os.path.join(HERE, "..", "participation.json"))
ENV_APPLIED = {h.strip().lstrip("@").lower() for h in os.environ.get("NFT_MY_APPLIED", "").split(",") if h.strip()}
MY_APPLIED = set(ENV_APPLIED)
MAX_TRIES = 3
CST = timezone(timedelta(hours=8))

NO_PUSH = False  # --no-push:本地 / 临时库测试时不推送

STAGES = ["预热", "白名单申请中", "白名单已截止", "铸造中", "已售罄", "已上市", "延期或取消", "未知"]
SLOW_STAGES = {"已售罄", "已上市", "延期或取消"}
TRACK_KEYS = ["name", "chain", "supply", "mint_price", "per_wallet", "mechanism", "stage", "wl_how", "wl_deadline",
              "mint_time", "mint_time_utc", "latest", "next_action", "risk", "verdict", "score", "saw_posts", "sources", "contract", "links"]
# 关键链接(页面上做成一排按钮);只收官方公布的
LINK_KEYS = ["site", "mint", "wl_apply", "wl_checker", "discord", "telegram", "docs", "market", "explorer"]
# AI 这次没查到就沿用上次的值(links 按键逐个沿用)
STICKY_KEYS = ["chain", "supply", "mint_price", "per_wallet", "mechanism", "wl_how", "wl_deadline", "mint_time", "mint_time_utc", "contract"]
FIELD_LABEL = {"stage": "阶段", "mint_time_utc": "铸造时间", "mint_price": "铸造价", "supply": "总量", "per_wallet": "单钱包上限"}
UNKNOWN_RE = re.compile(r"^\s*(|未公布|未提及|未知|不详|无|暂无|待定|待公布|n/?a|none|unknown|tbd|tba|—|-)\s*[。.]?\s*$", re.I)
HANDLE_RE = re.compile(r"^[A-Za-z0-9_]{1,15}$")

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"})

export_lock = threading.Lock()
stop_event = threading.Event()


def now_ms():
    return int(time.time() * 1000)


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def unknown(v):
    return v is None or (isinstance(v, str) and bool(UNKNOWN_RE.match(v)))


def fmt_cst(ms):
    return datetime.fromtimestamp(ms / 1000, tz=CST).strftime("%m-%d %H:%M")


# ---------- SQLite ----------
SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,          -- X 账号,小写
  display_handle TEXT NOT NULL,         -- 原大小写
  name TEXT,
  origin TEXT NOT NULL,                 -- watchlist / manual / discovered
  curated_json TEXT,                    -- 名单里的人工资料
  notes_json TEXT,                      -- KOL 观点 [{by,date,text,url}]
  discovered_json TEXT,                 -- AI 发现时的线索 {why, source_url, ...}
  seeded INTEGER NOT NULL DEFAULT 0,    -- 首轮发现的基准(不推送)
  active INTEGER NOT NULL DEFAULT 1,
  first_seen_ts INTEGER NOT NULL,
  track_status TEXT NOT NULL DEFAULT 'pending',
  track_tries INTEGER NOT NULL DEFAULT 0,
  track_error TEXT,
  last_track_ts INTEGER,
  next_track_ts INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,                   -- 最近一次成功核查(已合并沿用字段)
  snapshot_ts INTEGER,
  mint_ts INTEGER,                      -- 铸造开始时间(UTC ms)
  reminded_24h INTEGER NOT NULL DEFAULT 0,
  reminded_1h INTEGER NOT NULL DEFAULT 0,
  last_change_ts INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL,
  raw TEXT,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, ts);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  field TEXT NOT NULL,
  old TEXT,
  new TEXT,
  pushed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id, ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
"""


def open_db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
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


def day_key():
    return "cost:" + datetime.now(CST).strftime("%Y-%m-%d")


def add_cost(conn, cost):
    """累计 grok 花费:总额 + 北京时间当日"""
    c = cost or 0
    meta_set(conn, "grok_cost_usd", f"{float(meta_get(conn, 'grok_cost_usd', 0) or 0) + c:.4f}")
    meta_set(conn, day_key(), f"{float(meta_get(conn, day_key(), 0) or 0) + c:.4f}")


def spent_today(conn):
    return float(meta_get(conn, day_key(), 0) or 0)


def jload(s, default=None):
    try:
        return json.loads(s) if s else default
    except Exception:
        return default


# ---------- 推送 ----------
def tg_escape(text):
    return re.sub(r"([_*\[\]()~`>#+\-=|{}.!<])", r"\\\1", str(text))


def tg_send(text_md):
    if NO_PUSH or not TG_TOKEN or not TG_CHAT:
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
    if NO_PUSH or not PUSHPLUS_TOKEN:
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


# ---------- 价格(提醒必带当时价格) ----------
_eth_cache = {"ts": 0, "px": None}


def eth_price():
    if time.time() - _eth_cache["ts"] < 60 and _eth_cache["px"]:
        return _eth_cache["px"]
    sources = [
        ("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", lambda j: float(j["price"])),
        ("https://api.coinbase.com/v2/prices/ETH-USD/spot", lambda j: float(j["data"]["amount"])),
        ("https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT", lambda j: float(j["data"][0]["last"])),
    ]
    proxies = [None] + ([{"http": GROK_PROXY, "https": GROK_PROXY}] if GROK_PROXY else [])
    for px in proxies:
        for url, pick in sources:
            try:
                r = session.get(url, timeout=6, proxies=px)
                if r.ok:
                    v = pick(r.json())
                    if v > 0:
                        _eth_cache.update(ts=time.time(), px=v)
                        return v
            except Exception:
                continue
    return None


PRICE_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(W?ETH|USDC|USDT|USD|SOL|BNB|APE|POL|MATIC)\b", re.I)


def price_line(snap):
    mp = (snap or {}).get("mint_price") or "未公布"
    px = eth_price()
    s = f"铸造价 {mp}"
    m = next((m for m in PRICE_NUM_RE.finditer(mp) if m.group(2).upper() in ("ETH", "WETH")), None)
    if px:
        if m:
            s += f"(≈ ${float(m.group(1)) * px:,.0f})"
        s += f";ETH 现价 ${px:,.2f}"
    else:
        s += ";ETH 现价获取失败"
    return s


def known_links(row, snap):
    cur = jload(row["curated_json"], {}) or {}
    out = {**(cur.get("links") or {}), **((snap or {}).get("links") or {})}
    if not out.get("site") and cur.get("site"):
        out["site"] = cur["site"]
    return out


def page_anchor(row):
    """站上这个项目的卡片(点开直接看简介,不是页面顶部)"""
    return f"{PAGE_URL}#nft-{row['handle']}"


# 推送里链接的顺序:能马上点的排前面
LINK_ORDER = (("mint", "铸造页"), ("market", "OpenSea"), ("wl_apply", "白名单申请"), ("wl_checker", "名单查询"), ("site", "官网"))


def project_links(row, snap):
    known = known_links(row, snap)
    seen = set()
    links = []
    for k, label in LINK_ORDER:
        u = known.get(k)
        if u and u not in seen:
            seen.add(u)
            links.append(f"{label}: {u}")
    links.append(f"X: https://x.com/{row['display_handle']}")
    links.append(f"详情: {page_anchor(row)}")
    return links


def tg_links(row, snap):
    known = known_links(row, snap)
    seen = set()
    parts = []
    for k, label in LINK_ORDER:
        u = known.get(k)
        if u and u not in seen:
            seen.add(u)
            parts.append(f"[{tg_escape(label)}]({u})")
    parts.append(f"[X](https://x.com/{row['display_handle']})")
    parts.append(f"[详情]({page_anchor(row)})")
    return " · ".join(parts)


DATE_RE = re.compile(r"(20\d{2})-(\d{1,2})-(\d{1,2})")


def mint_day(snap):
    """铸造时间只公布到日期时,从 mint_time 文本里取日期(按北京时间理解)"""
    m = DATE_RE.search((snap or {}).get("mint_time") or "")
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=CST).date()
    except ValueError:
        return None


def mine_note(row):
    if row["handle"] not in MY_APPLIED:
        return ""
    return "\n\n**你已申请过这个项目的白名单**:留意官方名单查询页 / Discord 公布结果,铸造前确认申请钱包里备好铸造费。"


def push_changes(conn, row, snap, changes):
    name = snap.get("name") or row["name"] or row["display_handle"]
    first = next((c for c in changes if c[0] == "stage"), changes[0])
    headline = f"{FIELD_LABEL[first[0]]} {first[1] or '?'} → {first[2] or '?'}" if first[0] != "mint_time_utc" else f"铸造时间 {first[2]}"
    lines = [f"- {FIELD_LABEL[f]}: {o or '未公布'} → {n or '未公布'}" for f, o, n in changes]
    body = f"**{name}**(@{row['display_handle']})\n\n" + "\n".join(lines)
    body += mine_note(row)
    body += f"\n\n{price_line(snap)}"
    if not unknown(snap.get("mint_time")):
        body += f"\n\n铸造时间: {snap['mint_time']}"
    if not unknown(snap.get("next_action")):
        body += f"\n\n**现在该做**: {snap['next_action']}"
    if not unknown(snap.get("wl_how")):
        body += f"\n\n白名单: {snap['wl_how']}"
    body += "\n\n" + "\n\n".join(project_links(row, snap))
    body += "\n\nAI 联网检索可能看错,铸造前到官方 X 核对合约与链接,不连陌生站。"
    ok_wx = wechat_send(f"NFT 变动{'(已申请)' if mine_note(row) else ''}: {name} {headline}", body)
    tg = f"*NFT 变动*: {tg_escape(name)} \\(@{tg_escape(row['display_handle'])}\\)\n" + "\n".join(tg_escape(l) for l in lines)
    tg += "\n" + tg_escape(price_line(snap)) + "\n" + tg_links(row, snap)
    ok_tg = tg_send(tg)
    event(conn, "push_change", f"{row['handle']} {headline} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")
    return ok_wx or ok_tg


def push_reminder(conn, row, snap, hours, minutes=None):
    name = snap.get("name") or row["name"] or row["display_handle"]
    when = snap.get("mint_time") or fmt_cst(row["mint_ts"]) + " 北京时间"
    lead = f"约 {minutes} 分钟后开始" if minutes else f"约 {hours} 小时后开始"
    title = f"NFT 铸造提醒{'(已申请)' if mine_note(row) else ''}: {name} {lead}"
    body = f"**{name}**(@{row['display_handle']})\n\n铸造时间: {when}(北京时间 {fmt_cst(row['mint_ts'])}){mine_note(row)}\n\n{price_line(snap)}"
    for k, label in (("per_wallet", "单钱包上限"), ("mechanism", "机制"), ("wl_how", "白名单"), ("next_action", "现在该做")):
        if not unknown(snap.get(k)):
            body += f"\n\n{label}: {snap[k]}"
    body += "\n\n" + "\n\n".join(project_links(row, snap))
    body += "\n\n只从官方 X 置顶 / 官网进入铸造页,不点私信和评论区链接。"
    ok_wx = wechat_send(title, body)
    ok_tg = tg_send(f"*NFT 铸造提醒*: {tg_escape(name)} {tg_escape(lead)}\n{tg_escape(price_line(snap))}\n{tg_links(row, snap)}")
    event(conn, "push_reminder", f"{row['handle']} {lead} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")


def push_new_opportunity(conn, row, snap):
    """第一次核查就发现「正在铸造 / 马上铸造」——不能等下一次核查再推,平价公开铸造可能一小时内卖光"""
    name = snap.get("name") or row["name"] or row["display_handle"]
    stage = snap.get("stage") or ""
    head = "正在铸造" if stage == "铸造中" else "即将铸造"
    body = f"**{name}**(@{row['display_handle']})\n\n阶段: {stage}\n\n{price_line(snap)}"
    for k, label in (("supply", "总量"), ("mechanism", "机制"), ("per_wallet", "单钱包"), ("mint_time", "铸造时间"),
                     ("wl_how", "白名单"), ("next_action", "现在该做"), ("risk", "风险")):
        if not unknown(snap.get(k)):
            body += f"\n\n{label}: {snap[k]}"
    body += "\n\n" + "\n\n".join(project_links(row, snap))
    body += "\n\nAI 刚发现就直接推给你,没经过二次核实;只从官方 X 置顶 / 官网进铸造页,别点私信和评论区链接。"
    ok_wx = wechat_send(f"NFT {head}: {name}", body)
    ok_tg = tg_send(f"*NFT {tg_escape(head)}*: {tg_escape(name)} \\(@{tg_escape(row['display_handle'])}\\)\n"
                    + tg_escape(price_line(snap)) + "\n" + tg_links(row, snap))
    event(conn, "push_new_opportunity", f"{row['handle']} {stage} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")


def push_today_digest(conn, rows):
    """每天早上一条「今日铸造」汇总:所有项目合并成一条,替代逐个项目的重复提醒"""
    px = eth_price()
    lines = []
    for r, snap in rows:
        when = fmt_cst(r["mint_ts"])[6:] if r["mint_ts"] else "时刻未公布"
        mark = " ✅已申请" if r["handle"] in MY_APPLIED else (" ⭐名单" if r["origin"] != "discovered" else "")
        name = snap.get("name") or r["name"] or r["display_handle"]
        price = snap.get("mint_price") if not unknown(snap.get("mint_price")) else "价格未公布"
        k = known_links(r, snap)
        go = " · ".join(f"[{label}]({k[key]})" for key, label in LINK_ORDER if k.get(key)) or f"[X](https://x.com/{r['display_handle']})"
        lines.append(f"- **{when}** {name}(@{r['display_handle']}){mark}\n  {price};{snap.get('stage') or ''}\n  {go} · [详情]({page_anchor(r)})")
    body = "\n".join(lines) + f"\n\nETH 现价 {'$' + format(px, ',.2f') if px else '获取失败'}\n\n全部详情: {PAGE_URL}\n\n时刻未公布的会继续盯官方 X,公布后单独推送。只从官方链接进铸造页。"
    ok_wx = wechat_send(f"今日铸造 {len(rows)} 个", body)
    ok_tg = tg_send(f"*今日铸造 {len(rows)} 个*\n" + "\n".join(
        tg_escape(f"{(fmt_cst(r['mint_ts'])[6:] if r['mint_ts'] else '时刻未公布')} {snap.get('name') or r['display_handle']}") for r, snap in rows)
        + f"\n[日历]({PAGE_URL})")
    event(conn, "push_today_digest", f"n={len(rows)} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")


def push_day_reminder(conn, row, snap, days):
    """已申请的项目:只公布了铸造日期、没公布钟点时,前一天晚上和当天早上各提醒一次"""
    name = snap.get("name") or row["name"] or row["display_handle"]
    title = f"NFT 铸造提醒(已申请): {name} {'明天' if days == 1 else '今天'}铸造,具体时刻未公布"
    body = f"**{name}**(@{row['display_handle']})\n\n铸造时间: {snap.get('mint_time') or '未公布'}{mine_note(row)}\n\n{price_line(snap)}"
    for k, label in (("per_wallet", "单钱包上限"), ("mechanism", "机制"), ("next_action", "现在该做")):
        if not unknown(snap.get(k)):
            body += f"\n\n{label}: {snap[k]}"
    body += "\n\n" + "\n\n".join(project_links(row, snap))
    body += f"\n\n铸造日前后每 {NEAR_TRACK_EVERY_SEC // 60} 分钟核查一次官方 X,钟点一公布立刻推送,开铸前 1 小时和 10 分钟再各提醒一次。只从官方 X 置顶 / 官网进入铸造页。"
    ok_wx = wechat_send(title, body)
    ok_tg = tg_send(f"*NFT 铸造提醒*: {tg_escape(name)} {'明天' if days == 1 else '今天'}铸造,时刻未公布\n{tg_links(row, snap)}")
    event(conn, "push_day_reminder", f"{row['handle']} days={days} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")


def push_discovered(conn, items):
    px = eth_price()
    lines = []
    for it in items:
        parts = [f"**{it.get('name') or it['handle']}**(@{it['handle']})"]
        for k in ("chain", "mint_price", "supply", "mechanism"):
            if not unknown(it.get(k)):
                parts.append(str(it[k]))
        lines.append(" · ".join(parts) + (f"\n  {it['why']}" if it.get("why") else ""))
    body = "\n\n".join(lines) + f"\n\nETH 现价 {'$' + format(px, ',.2f') if px else '获取失败'}\n\n详情与后续核查: {PAGE_URL}\n\nAI 在 X 上找到的线索,未经核实;只认项目官方账号。"
    ok_wx = wechat_send(f"NFT 新机会 {len(items)} 个", body)
    ok_tg = tg_send(f"*NFT 新机会 {len(items)} 个*\n" + "\n".join(f"@{tg_escape(it['handle'])} {tg_escape(it.get('why') or '')}" for it in items) + f"\n[追踪页]({PAGE_URL})")
    event(conn, "push_discovered", f"n={len(items)} tg={'ok' if ok_tg else 'fail'} wx={'ok' if ok_wx else 'fail'}")


# ---------- grok ----------
def run_grok(prompt, timeout=None):
    """返回 (text, cost_usd)。不关联网:核查靠的就是 X 搜索"""
    fd, path = tempfile.mkstemp(prefix="nft-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(prompt)
    envd = dict(os.environ)
    envd["GROK_SUBAGENTS"] = "0"
    if GROK_PROXY:
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            envd[k] = GROK_PROXY
        envd["NO_PROXY"] = "localhost,127.0.0.1,::1,.local"
    argv = [GROK_BIN, "--prompt-file", path, "-m", GROK_MODEL, "--always-approve", "--no-subagents",
            "--max-turns", str(GROK_MAX_TURNS), "--output-format", "json"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout or GROK_TIMEOUT_SEC, env=envd)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if proc.returncode != 0:
        raise RuntimeError(f"grok 退出码 {proc.returncode}: {(proc.stderr or proc.stdout)[-600:]}")
    out = proc.stdout.strip()
    try:
        d = json.loads(out)
    except Exception:
        i = out.find("\n{")
        d = json.loads(out[i + 1:]) if i >= 0 else None
    if not isinstance(d, dict) or not isinstance(d.get("text"), str):
        raise RuntimeError("grok 输出不是预期的 JSON 外壳: " + out[:300])
    cost = d.get("total_cost_usd")
    return d["text"], float(cost) if isinstance(cost, (int, float)) else None


def extract_obj(text, required):
    """文本里最后一个含全部 required 键的 JSON 对象(模型会在 JSON 前后说话)"""
    dec = json.JSONDecoder()
    found = None
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = dec.raw_decode(text, m.start())
        except Exception:
            continue
        if isinstance(obj, dict) and all(k in obj for k in required):
            found = obj
    if found is None:
        raise RuntimeError("输出里没有合规 JSON: " + text[-300:])
    return found


def clean_str(v, limit=500):
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip()[:limit]


def parse_utc(s):
    s = clean_str(s, 64)
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    ms = int(dt.timestamp() * 1000)
    return ms if abs(ms - now_ms()) < 400 * 86400 * 1000 else None


def normalize_track(obj):
    out = {}
    for k in TRACK_KEYS:
        v = obj.get(k)
        if k == "score":
            try:
                v = max(0, min(10, int(round(float(v)))))
            except Exception:
                v = None
        elif k == "saw_posts":
            v = v is True or str(v).lower() == "true"
        elif k == "sources":
            v = [clean_str(u, 300) for u in (v if isinstance(v, list) else []) if re.match(r"^https?://", clean_str(u, 300))][:6]
        elif k == "links":
            src = v if isinstance(v, dict) else {}
            v = {lk: clean_str(src.get(lk), 300) for lk in LINK_KEYS if re.match(r"^https?://\S+$", clean_str(src.get(lk), 300))}
        else:
            v = clean_str(v)
        out[k] = v
    st = out["stage"]
    if st not in STAGES:
        if "取消" in st or "延期" in st:
            st = "延期或取消"
        elif "售罄" in st or "sold" in st.lower():
            st = "已售罄"
        elif "上市" in st or "二级" in st:
            st = "已上市"
        elif "铸造" in st and "中" in st:
            st = "铸造中"
        elif "白名单" in st and ("截止" in st or "结束" in st):
            st = "白名单已截止"
        elif "白名单" in st:
            st = "白名单申请中"
        elif "预热" in st:
            st = "预热"
        else:
            st = "未知"
    out["stage"] = st
    if parse_utc(out["mint_time_utc"]) is None:
        out["mint_time_utc"] = ""
    return out


def merge_sticky(new, prev):
    if not prev:
        return new
    kept = []
    for k in STICKY_KEYS:
        if unknown(new.get(k)) and not unknown(prev.get(k)):
            new[k] = prev[k]
            kept.append(k)
    links = dict(prev.get("links") or {})
    links.update(new.get("links") or {})
    new["links"] = links
    if new.get("stage") == "未知" and prev.get("stage") not in (None, "", "未知"):
        new["stage"] = prev["stage"]
        kept.append("stage")
    new["_kept"] = kept
    return new


def price_nums(s):
    if unknown(s):
        return ()
    if re.search(r"免费|free", s, re.I) and not PRICE_NUM_RE.search(s):
        return ("0",)
    return tuple(sorted({f"{float(m.group(1)):g}{m.group(2).upper().replace('WETH', 'ETH')}" for m in PRICE_NUM_RE.finditer(s)}))


def big_nums(s):
    """总量只比最大的那个数:grok 常把「已铸 906/1024、余量 118」这种实时进度塞进 supply,
    09-15 Rare Friends 因此每次核查都推一条「总量变动」"""
    if unknown(s):
        return ()
    s = re.sub(r"20\d{2}-\d{1,2}-\d{1,2}", " ", s)        # 日期里的年份不算
    s = re.sub(r"(?<=\d),(?=\d{3})", "", s)
    nums = [int(n) for n in re.findall(r"\d+", s) if int(n) >= 100]
    return (max(nums),) if nums else ()


def first_num(s):
    if unknown(s):
        return ()
    m = re.search(r"\d+", s)
    return (m.group(0),) if m else ()


def diff_snap(prev, new):
    """返回 [(field, old, new)];只比较对打新有决定意义的字段,文字改写不算"""
    out = []
    if not prev:
        return out
    if (prev.get("stage") or "未知") != (new.get("stage") or "未知"):
        out.append(("stage", prev.get("stage"), new.get("stage")))
    pm, nm = parse_utc(prev.get("mint_time_utc")), parse_utc(new.get("mint_time_utc"))
    # 铸造时间:只在「还没到的时间」变了、且文字描述也确实变了时才算(已经过去的阶段 grok 会在 WL / 公售时间之间来回取,不是真变动)
    if (nm is not None and nm > now_ms() - 3600 * 1000 and (pm is None or abs(nm - pm) > 3600 * 1000)
            and clean_str(prev.get("mint_time")) != clean_str(new.get("mint_time"))):
        out.append(("mint_time_utc", prev.get("mint_time") or (fmt_cst(pm) + " 北京时间" if pm else ""),
                    new.get("mint_time") or fmt_cst(nm) + " 北京时间"))
    for field, fn in (("mint_price", price_nums), ("supply", big_nums), ("per_wallet", first_num)):
        a, b = fn(prev.get(field)), fn(new.get(field))
        if b and a != b:
            out.append((field, prev.get(field), new.get(field)))
    return out


# ---------- 名单 ----------
def load_watchlist():
    try:
        with open(WATCHLIST_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log(f"watchlist 读取失败({WATCHLIST_PATH}): {e}")
        return None
    out = []
    for p in data.get("projects", []):
        h = str(p.get("handle") or "").lstrip("@").strip()
        if HANDLE_RE.match(h):
            out.append(p | {"handle": h})
    return out


def refresh_my_applied():
    global MY_APPLIED
    out = set(ENV_APPLIED)
    try:
        with open(PARTICIPATION_PATH, "r", encoding="utf-8") as f:
            for it in json.load(f).get("items", []):
                h = str(it.get("handle") or "").lstrip("@").strip()
                if it.get("section") == "nft" and HANDLE_RE.match(h):
                    out.add(h.lower())
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"participation.json 读取失败: {e}")
    if out != MY_APPLIED:
        log(f"已申请项目: {', '.join(sorted(out)) or '无'}")
    MY_APPLIED = out


def sync_watchlist(conn):
    items = load_watchlist()
    if items is None:
        return
    ts = now_ms()
    for p in items:
        key = p["handle"].lower()
        notes = p.get("notes") or []
        curated = {k: v for k, v in p.items() if k not in ("notes",)}
        row = conn.execute("SELECT id, origin FROM projects WHERE handle=?", (key,)).fetchone()
        if row is None:
            conn.execute("INSERT INTO projects(handle,display_handle,name,origin,curated_json,notes_json,first_seen_ts,next_track_ts)"
                         " VALUES(?,?,?,?,?,?,?,?)",
                         (key, p["handle"], p.get("name"), "watchlist", json.dumps(curated, ensure_ascii=False),
                          json.dumps(notes, ensure_ascii=False), ts, 0))
            log(f"名单新增 @{p['handle']} {p.get('name') or ''}")
            event(conn, "watchlist_add", p["handle"])
        else:
            conn.execute("UPDATE projects SET display_handle=?, name=COALESCE(?, name), origin='watchlist', curated_json=?, notes_json=?, active=1 WHERE id=?",
                         (p["handle"], p.get("name"), json.dumps(curated, ensure_ascii=False), json.dumps(notes, ensure_ascii=False), row["id"]))
    conn.commit()


# ---------- 核查 ----------
def track_prompt(row, prev):
    cur = jload(row["curated_json"], {}) or {}
    disc = jload(row["discovered_json"], {}) or {}
    notes = jload(row["notes_json"], []) or []
    today = datetime.now(CST).strftime("%Y-%m-%d %H:%M")
    known = {k: v for k, v in cur.items() if k not in ("handle",)} or disc
    return (
        "你是 NFT 打新助手。请用 X 搜索和网页搜索核查下面这个 NFT 项目的最新情况:重点读官方账号 "
        f"@{row['display_handle']} 最近 14 天的推文与置顶推文、官网,必要时参考其他人的推文。现在是北京时间 {today}。\n"
        "只写查到的事实,查不到的字段写「未公布」,不要臆造;推文里的时间要换算清楚时区。\n\n"
        f"已知资料(可能过时,以最新推文为准):{json.dumps(known, ensure_ascii=False)}\n"
        + (f"KOL 观点:{json.dumps(notes, ensure_ascii=False)}\n" if notes else "")
        + (f"上次核查结论:{json.dumps({k: prev.get(k) for k in TRACK_KEYS if k not in ('sources',)}, ensure_ascii=False)}\n" if prev else "")
        + "\n全部用简体中文(项目名与链名保留英文原名),每个字段一到两句话,不要 Markdown。最后只输出一个 JSON 对象,放在 ```json 代码块里,字段:\n"
        "name 项目名;chain 所在链;supply 总量与分配(如 总量 4444,公开 2222),不要写已铸数量、余量这类实时进度(那些写进 latest);mint_price 铸造价格(只写价格与币种,分阶段就都写,免费写 免费);"
        "per_wallet 单钱包上限;mechanism 分发机制(GTD / FCFS / 抽奖 / 荷兰拍 / 免费领 等);"
        "stage 只能取其一:" + " / ".join(STAGES) + ";"
        "wl_how 现在怎么拿白名单(具体动作与入口,已截止就写已截止);wl_deadline 白名单截止时间(带时区);"
        "mint_time 铸造时间,30 字以内(如 2026-09-16 21:00 UTC,只知道日期就写 2026-09-16 具体时刻未公布);mint_time_utc 铸造开始时间换算成 UTC 的 ISO8601(如 2026-09-20T14:00:00Z),没公布具体时间就写空字符串;"
        "latest 最新动态,1–2 句,带日期;next_action 一句话:普通人现在该做什么;risk 风险(仿冒链接、改价、团队背景、名额太少等);"
        "verdict 一句话结论;score 0 到 10 的整数,10 = 机会清晰、普通人还来得及参与,0 = 骗局或已无机会;"
        "contract 合约地址(官方公布的才写,注明链),没有写「未公布」;"
        "links 关键链接对象,只收官方账号(置顶、推文、简介)或官网公布的完整网址,拿不准是不是官方的一律不写,没有的键直接省略,键:"
        "site 官网,mint 铸造页,wl_apply 白名单申请表,wl_checker 名单查询页,discord,telegram,docs 文档或白皮书,"
        "market 官方二级市场集合页(OpenSea / Magic Eden 等;在 OpenSea 上铸造的项目把铸造链接也写进 mint);explorer 合约浏览器页。"
        "mint 与 market 这两个链接最重要,尽量找全;"
        "saw_posts 布尔值:这次是否真的读到了该官方账号的推文;sources 参考链接数组(推文或官网链接,最多 6 个)。\n"
    )


def stage_of(snap):
    return (snap or {}).get("stage") or ""


def schedule_interval(row, snap, mint_ts):
    """分档:已申请项目铸造当天冲刺 > 铸造前后 > 已定日期 > 白名单开放 > 没消息 > 已结束;AI 发现的项目再乘 DISCOVERED_FACTOR"""
    now = now_ms()
    today = datetime.now(CST).date()
    day = mint_day(snap)
    # 铸造前后只给已申请 / 名单项目加密(AI 发现的项目不进这档:用户要的是"发现",不是反复核实)
    applied = row["handle"] in MY_APPLIED
    if applied and stage_of(snap) not in SLOW_STAGES and (
            (day and day == today) or (mint_ts and 0 < mint_ts - now < 6 * 3600 * 1000)):
        return SPRINT_TRACK_EVERY_SEC  # 已申请项目的铸造当天:冲刺模式
    if (row["origin"] != "discovered" or applied) and stage_of(snap) not in SLOW_STAGES:
        near = APPLIED_NEAR_TRACK_EVERY_SEC if applied else NEAR_TRACK_EVERY_SEC
        if mint_ts and -6 * 3600 * 1000 < mint_ts - now < 48 * 3600 * 1000:
            return near
        # 只公布了日期没公布钟点:铸造日前一天到当天也盯着钟点
        # 日期已过还没开铸的多半是官方延期,不再按「铸造当天」盯,走下面的分档(已申请项目有 12h 下限)
        if not mint_ts and day and 0 <= (day - today).days <= 1:
            return near
    stage = (snap or {}).get("stage") or ""
    if stage == "铸造中":
        # 开铸超过 12 小时还挂着「铸造中」的多半是长期开放铸造,没必要两小时一查
        stale = mint_ts and now - mint_ts > 12 * 3600 * 1000
        b = DATED_TRACK_EVERY_SEC if stale else MINTING_TRACK_EVERY_SEC
        return b if row["origin"] != "discovered" else int(b * max(DISCOVERED_FACTOR, 1))
    if stage in SLOW_STAGES:
        base = ENDED_TRACK_EVERY_SEC
    elif (mint_ts and mint_ts > now) or (day and day >= today):
        base = DATED_TRACK_EVERY_SEC
    elif stage == "白名单申请中":
        base = WL_TRACK_EVERY_SEC
    else:
        base = QUIET_TRACK_EVERY_SEC
    if row["origin"] == "discovered" and stage not in SLOW_STAGES:
        base = int(base * max(DISCOVERED_FACTOR, 1))
    # 已申请的项目有下限:铸造日过了、状态还没变的(官方延期)也不能掉进 7 天档,否则真开铸时没人盯
    if applied and stage not in SLOW_STAGES:
        base = min(base, APPLIED_MAX_TRACK_EVERY_SEC)
    return base


def track_project(conn, row):
    pid = row["id"]
    tries = row["track_tries"] + 1
    conn.execute("UPDATE projects SET track_status='running', track_tries=? WHERE id=?", (tries, pid))
    conn.commit()
    prev = jload(row["snapshot_json"])
    try:
        text, cost = run_grok(track_prompt(row, prev))
        snap = merge_sticky(normalize_track(extract_obj(text, ["stage", "mint_price", "next_action"])), prev)
    except Exception as e:
        err = str(e)[:800]
        # 402 / 连败写进共用标记:BTT 速览与空投雷达据此改走 codex,本进程据此暂停
        if ai_fallback.note_grok_fail(e):
            log("grok 配额耗尽,NFT 追踪暂停(不走 codex 备用)")
            event(conn, "grok_exhausted", err[:300])
        streak = int(meta_get(conn, "fail_streak", 0) or 0) + 1
        meta_set(conn, "fail_streak", streak)
        meta_set(conn, "last_error", err[:300])
        if tries < MAX_TRIES:
            conn.execute("UPDATE projects SET track_status='pending', track_error=?, next_track_ts=? WHERE id=?", (err, now_ms() + 600_000 * tries, pid))
        else:
            conn.execute("UPDATE projects SET track_status='failed', track_tries=0, track_error=?, last_track_ts=?, next_track_ts=? WHERE id=?",
                         (err, now_ms(), now_ms() + schedule_interval(row, prev, row["mint_ts"]) * 1000, pid))
        conn.commit()
        log(f"核查失败 @{row['display_handle']}(第 {tries} 次): {err[:200]}")
        event(conn, "track_failed", f"{row['handle']} try={tries} {err[:300]}")
        if streak in (10, 50):
            wechat_send("NFT 追踪异常", f"grok 核查已连续失败 {streak} 次,最新错误:{err[:300]}")
        return
    ts = now_ms()
    ai_fallback.note_grok_ok()  # grok 又能用了:清共用标记,另外三条链路也一起切回来
    meta_set(conn, "fail_streak", 0)
    meta_set(conn, "last_error", None)
    meta_set(conn, "last_track_ts", ts)
    mint_ts = parse_utc(snap.get("mint_time_utc"))
    changes = diff_snap(prev, snap)
    trusted = snap.get("saw_posts") or bool(snap.get("sources"))
    for f, o, n in changes:
        conn.execute("INSERT INTO changes(project_id,ts,field,old,new,pushed) VALUES(?,?,?,?,?,0)", (pid, ts, f, o, n))
    upd = {
        "name": snap.get("name") or row["name"], "track_status": "done", "track_tries": 0, "track_error": None,
        "last_track_ts": ts, "snapshot_json": json.dumps(snap, ensure_ascii=False), "snapshot_ts": ts, "mint_ts": mint_ts,
        "next_track_ts": ts + schedule_interval(row, snap, mint_ts) * 1000,
    }
    if changes:
        upd["last_change_ts"] = ts
    if mint_ts != row["mint_ts"]:
        upd.update(reminded_24h=0, reminded_1h=0)
    conn.execute(f"UPDATE projects SET {', '.join(k + '=?' for k in upd)} WHERE id=?", [*upd.values(), pid])
    conn.execute("INSERT INTO snapshots(project_id,ts,json,raw,cost_usd) VALUES(?,?,?,?,?)", (pid, ts, upd["snapshot_json"], text[-6000:], cost))
    conn.commit()
    add_cost(conn, cost)
    log(f"核查完成 @{row['display_handle']} → {snap['stage']} / {snap.get('score')}分 / 铸造 {snap.get('mint_time') or '未公布'}"
        f"{' / 变动 ' + ','.join(c[0] for c in changes) if changes else ''}{' / 沿用 ' + ','.join(snap['_kept']) if snap.get('_kept') else ''}"
        f" / ${cost or 0:.3f}")
    event(conn, "track_done", f"{row['handle']} stage={snap['stage']} changes={len(changes)} cost={cost}")
    if changes and trusted:
        fresh = conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
        if push_changes(conn, fresh, snap, changes):
            conn.execute("UPDATE changes SET pushed=1 WHERE project_id=? AND ts=?", (pid, ts))
            conn.commit()
    elif changes:
        log(f"  变动未推送:这次没读到官方推文也没有来源链接")
    # 首次核查:正常只做基准不推,但「正在铸造 / 48 小时内铸造」是马上要动手的机会,必须立刻推
    if prev is None and trusted and not row["seeded"]:
        day = mint_day(snap)
        soon = (mint_ts and 0 < mint_ts - ts < 48 * 3600 * 1000) or (day and 0 <= (day - datetime.now(CST).date()).days <= 1)
        if snap.get("stage") == "铸造中" or soon:
            push_new_opportunity(conn, conn.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone(), snap)


def check_reminders(conn):
    now = now_ms()
    rows = conn.execute("SELECT * FROM projects WHERE active=1 AND mint_ts IS NOT NULL AND mint_ts>? AND (reminded_24h=0 OR reminded_1h=0)", (now,)).fetchall()
    for r in rows:
        snap = jload(r["snapshot_json"], {}) or {}
        if not (snap.get("saw_posts") or snap.get("sources")):
            continue
        if snap.get("stage") in SLOW_STAGES:
            continue
        dt = r["mint_ts"] - now
        if dt <= 3600 * 1000 and not r["reminded_1h"]:
            push_reminder(conn, r, snap, max(1, round(dt / 3600_000)))
            conn.execute("UPDATE projects SET reminded_1h=1, reminded_24h=1 WHERE id=?", (r["id"],))
        elif 3600 * 1000 < dt <= 24 * 3600 * 1000 and not r["reminded_24h"]:
            push_reminder(conn, r, snap, round(dt / 3600_000))
            conn.execute("UPDATE projects SET reminded_24h=1 WHERE id=?", (r["id"],))
        conn.commit()
    now_cst = datetime.now(CST)
    today_rows = []
    for r in conn.execute("SELECT * FROM projects WHERE active=1").fetchall():
        snap = jload(r["snapshot_json"], {}) or {}
        if snap.get("stage") in SLOW_STAGES:
            continue
        # 今日铸造汇总:所有项目(含 AI 发现的)按铸造日归集,早 8 点后推一条
        d0 = mint_day(snap) or (datetime.fromtimestamp(r["mint_ts"] / 1000, CST).date() if r["mint_ts"] else None)
        if d0 == now_cst.date() and (not r["mint_ts"] or r["mint_ts"] > now - 6 * 3600 * 1000):
            today_rows.append((r, snap))
        if r["handle"] not in MY_APPLIED and r["origin"] == "discovered":
            continue  # 单条提醒只给名单与已申请项目,AI 发现的走每日汇总
        if r["mint_ts"]:
            # 已申请的项目开铸前 10 分钟再补一次
            dt = r["mint_ts"] - now
            key = f"remind10:{r['handle']}:{r['mint_ts']}"
            if 0 < dt <= 12 * 60 * 1000 and not meta_get(conn, key):
                push_reminder(conn, r, snap, 0, minutes=max(1, round(dt / 60_000)))
                meta_set(conn, key, "1")
            continue
        d = mint_day(snap)
        if not d:
            continue
        days = (d - now_cst.date()).days
        # 前一天 20 点后提醒一次,当天 8 点后再提醒一次(避开半夜推送)
        if (days == 1 and now_cst.hour >= 20) or (days == 0 and now_cst.hour >= 8):
            key = f"dayremind:{r['handle']}:{d}:{days}"
            if not meta_get(conn, key):
                push_day_reminder(conn, r, snap, days)
                meta_set(conn, key, "1")
    digest_key = f"todaydigest:{now_cst.date()}"
    if today_rows and now_cst.hour >= 8 and not meta_get(conn, digest_key):
        today_rows.sort(key=lambda x: x[0]["mint_ts"] or 0)
        push_today_digest(conn, today_rows)
        meta_set(conn, digest_key, "1")


# ---------- 发现 ----------
DISCOVER_KEYS = ["handle", "name", "chain", "supply", "mint_price", "mechanism", "mint_status", "why", "source_url"]
URGENT_STATUS = ("正在铸造", "今天", "明天")
# 平台 / 生态大号不是打新项目,别收进来(09-16 收过 @opensea)
HANDLE_BLACKLIST = {"opensea", "arc", "circle", "arc_network", "magiceden", "blur_io", "blur", "ethereum", "base",
                    "robinhoodapp", "robinhoodcrypto", "x", "binance", "okx", "coinbase", "solana", "zcashcommunity"}
URGENT_RE = re.compile(r"正在铸造|铸造中|今天|今晚|明天|马上|即将开铸|mint(?:ing)? is live|live now|minting now|mints? today|today|tonight|tomorrow", re.I)


def clue_is_urgent(clue):
    """发现线索是否属于「马上要开铸」——只有这种才值得立刻花一次核查并推送"""
    st = clue.get("mint_status") or ""
    if any(k in st for k in URGENT_STATUS):
        return True
    return bool(URGENT_RE.search(" ".join(str(clue.get(k) or "") for k in ("mint_status", "why", "mechanism"))))


def discover(conn):
    handles = [r["display_handle"] for r in conn.execute("SELECT display_handle FROM projects").fetchall()]
    today = datetime.now(CST).strftime("%Y-%m-%d")
    prompt = (
        f"现在是北京时间 {today}。请用 X 搜索找过去 3 天里中英文加密圈正在讨论的 NFT 打新机会:白名单申请、GTD / FCFS WL、allowlist、free mint、"
        "mint 即将开始的新系列(中文关键词如 NFT 白名单、打新、铸造;英文如 NFT whitelist, GTD WL, allowlist, free mint, mint date)。"
        "**最优先找此刻正在铸造(mint is live)、今天或明天开铸的**,尤其是不需要白名单、平价公开铸造、先到先得的(这种常常一两个小时就卖光);"
        "其次才是还在预热、白名单阶段的。要有官方 X 账号;排除早已上市的老系列、明显骗局、纯地板价讨论和已经售罄的。\n"
        f"下面这些账号已经在追踪,不要重复:{', '.join('@' + h for h in handles) or '无'}。\n"
        f"只写查到的事实,不要臆造。**最多给 {DISCOVER_MAX_NEW} 个**,按紧急程度排序(正在铸造的排最前),宁缺毋滥:"
        "只收真正的 NFT 打新项目,不要收 OpenSea、Circle、Arc 官方这类平台或生态大号。"
        "全部用简体中文(项目名保留原名),最后只输出一个 JSON 对象,放在 ```json 代码块里:\n"
        '{"items":[{"handle":"官方 X 账号,不带 @","name":"项目名","chain":"链","supply":"总量","mint_price":"铸造价","mechanism":"分发机制",'
        '"mint_status":"只能取其一:正在铸造 / 今天 / 明天 / 本周 / 未公布","why":"一句话为什么值得关注(谁在讨论、热度、名额)",'
        '"source_url":"你看到的那条推文链接"}]}\n'
        "mint_status 一定要按实际情况填准:填错成「正在铸造」会造成误报,填漏会让人错过开铸。\n"
    )
    text, cost = run_grok(prompt, timeout=max(GROK_TIMEOUT_SEC, 900))  # 发现要搜多轮,比单项目核查慢得多
    obj = extract_obj(text, ["items"])
    items = obj.get("items") if isinstance(obj.get("items"), list) else []
    first_run = meta_get(conn, "discover_seeded") != "1"
    ts = now_ms()
    new_items = []
    urgent_used = 0
    for it in items[:DISCOVER_MAX_NEW * 3]:
        if len(new_items) >= DISCOVER_MAX_NEW:
            break
        if not isinstance(it, dict):
            continue
        h = clean_str(it.get("handle"), 40).lstrip("@")
        h = re.sub(r"^https?://(?:www\.)?(?:x|twitter)\.com/", "", h).split("/")[0]
        if not HANDLE_RE.match(h) or h.lower() in HANDLE_BLACKLIST:
            continue
        if conn.execute("SELECT 1 FROM projects WHERE handle=?", (h.lower(),)).fetchone():
            continue
        clue = {k: clean_str(it.get(k), 300) for k in DISCOVER_KEYS}
        clue["handle"] = h
        if clue["source_url"] and not re.match(r"^https?://", clue["source_url"]):
            clue["source_url"] = ""
        urgent = clue_is_urgent(clue) and urgent_used < DISCOVER_MAX_URGENT
        if urgent:
            urgent_used += 1
        first_at = 0 if urgent else ts + DISCOVERED_FIRST_DELAY_SEC * 1000
        conn.execute("INSERT INTO projects(handle,display_handle,name,origin,discovered_json,seeded,first_seen_ts,next_track_ts) VALUES(?,?,?,?,?,?,?,?)",
                     (h.lower(), h, clue["name"] or None, "discovered", json.dumps(clue, ensure_ascii=False), 1 if first_run else 0, ts, first_at))
        clue["_urgent"] = urgent
        new_items.append(clue)
    conn.commit()
    meta_set(conn, "discover_seeded", "1")
    meta_set(conn, "last_discover_ts", ts)
    meta_set(conn, "next_discover_ts", ts + DISCOVER_EVERY_SEC * 1000)
    add_cost(conn, cost)
    urgent_n = sum(1 for c in new_items if c.get("_urgent"))
    log(f"发现一轮:grok 给出 {len(items)} 个,新入库 {len(new_items)} 个(其中 {urgent_n} 个马上开铸→立刻核查,"
        f"其余 {DISCOVERED_FIRST_DELAY_SEC // 3600}h 后再查){'(首轮基准,不推送)' if first_run else ''} / ${cost or 0:.3f}")
    event(conn, "discover", f"items={len(items)} new={len(new_items)} first={first_run} cost={cost}")
    if new_items and not first_run:
        push_discovered(conn, new_items)
    prune_discovered(conn)


def prune_discovered(conn):
    """AI 发现的项目超过上限:按 评分低 → 收录早 的顺序停止追踪。DISCOVER_MAX_ACTIVE=0 则不限(默认)"""
    if DISCOVER_MAX_ACTIVE <= 0:
        return
    rows = conn.execute("SELECT id, snapshot_json, first_seen_ts FROM projects WHERE origin='discovered' AND active=1").fetchall()
    if len(rows) <= DISCOVER_MAX_ACTIVE:
        return
    def key(r):
        s = jload(r["snapshot_json"], {}) or {}
        dead = s.get("stage") in SLOW_STAGES
        return (0 if dead else 1, s.get("score") if isinstance(s.get("score"), int) else 5, r["first_seen_ts"])
    for r in sorted(rows, key=key)[: len(rows) - DISCOVER_MAX_ACTIVE]:
        conn.execute("UPDATE projects SET active=0 WHERE id=?", (r["id"],))
    conn.commit()


# ---------- 导出给网站 ----------
def export_json(conn):
    with export_lock:
        rows = conn.execute("SELECT * FROM projects WHERE active=1 ORDER BY origin='discovered', first_seen_ts ASC").fetchall()

        def iso(ms):
            return None if ms in (None, "") else datetime.fromtimestamp(int(float(ms)) / 1000, tz=timezone.utc).isoformat()

        out_rows = []
        for r in rows:
            chs = conn.execute("SELECT ts, field, old, new, pushed FROM changes WHERE project_id=? ORDER BY ts DESC, id DESC LIMIT 10", (r["id"],)).fetchall()
            snap = jload(r["snapshot_json"])
            if snap:
                snap = {k: v for k, v in snap.items() if k != "_kept"} | {"kept": snap.get("_kept") or []}
            out_rows.append({
                "id": r["id"],
                "handle": r["display_handle"],
                "xUrl": f"https://x.com/{r['display_handle']}",
                "name": r["name"],
                "origin": r["origin"],
                "seeded": bool(r["seeded"]),
                "curated": jload(r["curated_json"]),
                "notes": jload(r["notes_json"], []) or [],
                "discovered": jload(r["discovered_json"]),
                "firstSeenTs": r["first_seen_ts"],
                "trackStatus": r["track_status"],
                "trackError": (r["track_error"] or None) if r["track_status"] == "failed" else None,
                "lastTrackTs": r["last_track_ts"],
                "nextTrackTs": r["next_track_ts"] or None,
                "snapshot": snap,
                "snapshotTs": r["snapshot_ts"],
                "mintTs": r["mint_ts"],
                "lastChangeTs": r["last_change_ts"],
                "changes": [{"ts": c["ts"], "field": c["field"], "old": c["old"], "new": c["new"], "pushed": bool(c["pushed"])} for c in chs],
            })
        data = {
            "generatedAt": iso(now_ms()),
            "lastTrackAt": iso(meta_get(conn, "last_track_ts")),
            "lastDiscoverAt": iso(meta_get(conn, "last_discover_ts")),
            "nextDiscoverAt": iso(meta_get(conn, "next_discover_ts")),
            "lastError": meta_get(conn, "last_error"),
            "failStreak": int(meta_get(conn, "fail_streak", 0) or 0),
            "grokExhausted": ai_fallback.grok_exhausted(),
            "grokExhaustedInfo": ai_fallback.exhausted_info(),
            "trackEverySec": DATED_TRACK_EVERY_SEC,
            "nearTrackEverySec": NEAR_TRACK_EVERY_SEC,
            "appliedNearTrackEverySec": APPLIED_NEAR_TRACK_EVERY_SEC,
            "wlTrackEverySec": WL_TRACK_EVERY_SEC,
            "quietTrackEverySec": QUIET_TRACK_EVERY_SEC,
            "endedTrackEverySec": ENDED_TRACK_EVERY_SEC,
            "discoveredFactor": DISCOVERED_FACTOR,
            "discoverEverySec": DISCOVER_EVERY_SEC if DISCOVER_ENABLED else None,
            "count": len(out_rows),
            "rows": out_rows,
        }
        os.makedirs(os.path.dirname(EXPORT_PATH) or ".", exist_ok=True)
        tmp = f"{EXPORT_PATH}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.chmod(tmp, 0o644)
        os.replace(tmp, EXPORT_PATH)


# ---------- 主循环 ----------
_paused_logged_at = 0


def grok_paused(conn):
    """grok 耗尽标记还在冷却期内 → 本轮什么都不干。日志十分钟一条,别刷屏"""
    global _paused_logged_at
    if not ai_fallback.grok_exhausted():
        return False
    if now_ms() - _paused_logged_at > 600_000:
        _paused_logged_at = now_ms()
        info = ai_fallback.exhausted_info() or {}
        log(f"grok 耗尽,NFT 追踪暂停(自 {info.get('since', '?')},{info.get('retryAt', '?')} 后再试;不走 codex 备用)")
    return True


def run_one_job(conn):
    """跑一件到期的活:先核查到期项目(名单优先),再发现。返回是否跑了"""
    if grok_paused(conn):
        return False
    now = now_ms()
    over_budget = DAILY_BUDGET_USD > 0 and spent_today(conn) >= DAILY_BUDGET_USD
    if over_budget and meta_get(conn, "budget_logged") != day_key():
        meta_set(conn, "budget_logged", day_key())
        log(f"今日 grok 花费 ${spent_today(conn):.2f} 已到上限 ${DAILY_BUDGET_USD:.2f},只核查铸造临近的项目")
        event(conn, "budget_hit", f"{spent_today(conn):.2f}")
    if over_budget:
        # 超预算:只保留快铸造的(提醒准确性优先),发现暂停到明天。
        # 已申请但只公布了日期的项目也要留下,否则铸造当天反而不查了(Arclings 就是这种)
        row = None
        today = datetime.now(CST).date()
        for r in conn.execute("SELECT * FROM projects WHERE active=1 AND next_track_ts<=? ORDER BY origin='discovered', next_track_ts", (now,)).fetchall():
            if r["mint_ts"] and now - 6 * 3600 * 1000 < r["mint_ts"] < now + 48 * 3600 * 1000:
                row = r
                break
            if r["handle"] in MY_APPLIED:
                d = mint_day(jload(r["snapshot_json"], {}) or {})
                if d and -1 <= (d - today).days <= 1:
                    row = r
                    break
    else:
        row = conn.execute("SELECT * FROM projects WHERE active=1 AND next_track_ts<=? ORDER BY origin='discovered', next_track_ts LIMIT 1", (now,)).fetchone()
    if row is not None:
        track_project(conn, row)
        return True
    if DISCOVER_ENABLED and not over_budget and int(meta_get(conn, "next_discover_ts", 0) or 0) <= now:
        try:
            discover(conn)
        except Exception as e:
            meta_set(conn, "next_discover_ts", now + 3600 * 1000)
            if ai_fallback.note_grok_fail(e):
                log("grok 配额耗尽,NFT 追踪暂停(不走 codex 备用)")
                event(conn, "grok_exhausted", str(e)[:300])
            log(f"发现一轮失败: {str(e)[:300]}")
            event(conn, "discover_failed", str(e)[:300])
        return True
    return False


def main():
    global NO_PUSH
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true", help="不推送(临时库测试)")
    ap.add_argument("--track", metavar="HANDLE", help="立刻核查一个项目后退出")
    ap.add_argument("--track-all", action="store_true", help="同步名单后把所有项目各核查一次,导出后退出")
    ap.add_argument("--discover-once", action="store_true", help="跑一轮发现后退出")
    ap.add_argument("--export-only", action="store_true", help="同步名单并导出 export.json 后退出(不调 grok)")
    ap.add_argument("--add", metavar="HANDLE", help="手动加一个项目(origin=manual),下一轮就会核查")
    ap.add_argument("--name", help="--add 的项目名")
    ap.add_argument("--note", help="--add 的观点 / 备注")
    ap.add_argument("--by", help="--note 的出处(如 @Ron521520)")
    args = ap.parse_args()
    NO_PUSH = args.no_push

    conn = open_db()
    refresh_my_applied()
    sync_watchlist(conn)

    if args.add:
        h = args.add.lstrip("@")
        if not HANDLE_RE.match(h):
            sys.exit(f"账号不合法: {args.add}")
        notes = [{"by": args.by or "", "date": datetime.now(CST).strftime("%Y-%m-%d"), "text": args.note}] if args.note else []
        if conn.execute("SELECT 1 FROM projects WHERE handle=?", (h.lower(),)).fetchone():
            conn.execute("UPDATE projects SET active=1, next_track_ts=0 WHERE handle=?", (h.lower(),))
        else:
            conn.execute("INSERT INTO projects(handle,display_handle,name,origin,notes_json,first_seen_ts,next_track_ts) VALUES(?,?,?,?,?,?,0)",
                         (h.lower(), h, args.name, "manual", json.dumps(notes, ensure_ascii=False), now_ms()))
        conn.commit()
        export_json(conn)
        log(f"已加入 @{h}")
        return
    if args.export_only:
        export_json(conn)
        log(f"导出 {EXPORT_PATH}")
        return
    if args.track or args.track_all:
        where = "handle=?" if args.track else "active=1"
        params = (args.track.lstrip("@").lower(),) if args.track else ()
        for row in conn.execute(f"SELECT * FROM projects WHERE {where} ORDER BY id", params).fetchall():
            track_project(conn, row)
        export_json(conn)
        return
    if args.discover_once:
        discover(conn)
        export_json(conn)
        return

    log(f"NFT 追踪启动: 名单 {len(load_watchlist() or [])} 个, 核查分档 铸造前后 已申请 {APPLIED_NEAR_TRACK_EVERY_SEC}s / 名单 {NEAR_TRACK_EVERY_SEC}s / 有日期 {DATED_TRACK_EVERY_SEC}s / "
        f"白名单 {WL_TRACK_EVERY_SEC}s / 无日程 {QUIET_TRACK_EVERY_SEC}s / 已结束 {ENDED_TRACK_EVERY_SEC}s(发现项目 ×{DISCOVERED_FACTOR:g}), "
        f"发现 {DISCOVER_EVERY_SEC if DISCOVER_ENABLED else 'off'}s, 项目数上限 {DISCOVER_MAX_ACTIVE or '不限'}, "
        f"推送 TG={'on' if TG_TOKEN and TG_CHAT else 'off'} 微信={'on' if PUSHPLUS_TOKEN else 'off'} ({GROK_MODEL})")
    conn.execute("UPDATE projects SET track_status='pending' WHERE track_status='running'")
    conn.commit()
    export_json(conn)
    wl_mtime = None
    while not stop_event.is_set():
        ran = False
        try:
            try:
                mt = os.path.getmtime(WATCHLIST_PATH)
            except OSError:
                mt = None
            if mt != wl_mtime:
                wl_mtime = mt
                sync_watchlist(conn)
            refresh_my_applied()
            check_reminders(conn)
            ran = run_one_job(conn)
        except Exception as e:
            log(f"主循环异常: {e}\n{traceback.format_exc()[-800:]}")
            event(conn, "loop_error", str(e)[:300])
        try:
            export_json(conn)
        except Exception as e:
            log(f"导出失败: {e}")
        stop_event.wait(5 if ran else 30)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("手动退出")
    except Exception:
        log("致命错误:\n" + traceback.format_exc())
        sys.exit(1)
