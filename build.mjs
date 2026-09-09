#!/usr/bin/env node
// airdrop.satloot.com 静态页生成器。两个大类 × 两种语言:
//   /          空投项目(zh-CN)—— riskdesk 侧车(127.0.0.1:5177,本机直连即站主)的空投雷达存档
//   /btt/      BTT 新帖(zh-CN)—— btt/btt_monitor.py 导出的 export.json(bitcointalk 山寨板新帖 + grok 中文速览)
//   /en/  /en/btt/  同一模板按 LOCALES.en 渲染的英文壳;项目描述数据本身是中文来源,英文页原样保留
// 由 systemd 定时器每 5 分钟跑一次;任一数据源挂了就保留上一版文件,不会把站点写空。
//
// 环境变量:
//   AIRDROP_API_BASE     侧车地址,默认 http://127.0.0.1:5177
//   AIRDROP_BTT_JSON     BTT 导出文件,默认 /var/lib/btt-monitor/export.json(不存在则 BTT 页显示未启动)
//   AIRDROP_OUT_DIR      输出目录,默认 ./dist
//   AIRDROP_FIXTURE_DIR  本地测试:从该目录读 projects.json / status.json / reports.json / btt-export.json,不联网
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.AIRDROP_API_BASE || 'http://127.0.0.1:5177').replace(/\/$/, '');
const BTT_JSON = process.env.AIRDROP_BTT_JSON || '/var/lib/btt-monitor/export.json';
const OUT_DIR = process.env.AIRDROP_OUT_DIR || path.join(__dirname, 'dist');
const FIXTURE_DIR = process.env.AIRDROP_FIXTURE_DIR || null;
const SITE_URL = 'https://airdrop.satloot.com/';
const SOURCE_URL = 'https://earn.satloot.com/app/#/airdrop';
const BTT_BOARD_URL = 'https://bitcointalk.org/index.php?board=159.0';
const TZ = 'Asia/Shanghai';

async function getJson(pathname, fixtureName) {
  if (FIXTURE_DIR) {
    return JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, fixtureName), 'utf8'));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(API_BASE + pathname, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** BTT 导出是可选数据源:没有就返回 null,页面照常生成 */
async function loadBtt() {
  const file = FIXTURE_DIR ? path.join(FIXTURE_DIR, 'btt-export.json') : BTT_JSON;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    console.warn(`[airdrop-site] BTT export unavailable (${file}): ${err?.message || err}`);
    return null;
  }
}

// ---------- 语言表 ----------
// 页面"壳"的全部文案都在这里;空投/BTT 的描述字段是中文来源、无法机器翻译,英文页只翻标签与枚举值。
// 友链的 href 两种语言共用,标签按下标对应 L.friends。
const FRIEND_URLS = [
  'https://satloot.com/', 'https://sim.satloot.com/', 'https://bnbbang.com/', 'https://bang.satloot.com/',
  'https://earn.satloot.com/', 'https://game.satloot.com/', 'https://tool.satloot.com/', 'https://trx.satloot.com/', 'https://faucet.satloot.com/',
];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// BTT 速览的 kind / mining 是 grok --json-schema 里的固定枚举(见 btt/btt_monitor.py),英文页按表翻;表外原样保留
const BTT_KIND_EN = {
  '代币发行': 'Token launch', 'ICO或预售': 'ICO / presale', '空投或Bounty': 'Airdrop / bounty', '矿币或PoW': 'PoW coin',
  'NFT': 'NFT', 'DeFi协议': 'DeFi protocol', '工具或服务': 'Tool / service', '交易所或平台': 'Exchange / platform',
  '其他': 'Other', '垃圾或广告': 'Spam / ad',
};
const BTT_MINING_EN = {
  'CPU可挖': 'CPU-minable', 'GPU可挖': 'GPU-minable', 'ASIC': 'ASIC', '不可挖或非矿币': 'Not minable', '未提及': 'Not mentioned',
};

const LOCALES = {
  zh: {
    code: 'zh', htmlLang: 'zh-CN', ogLocale: 'zh_CN', ogLocaleAlt: 'en_US', dir: '',
    switchLabel: 'EN', switchLang: 'en',
    brand: 'SatLoot · 空投雷达',
    navLabel: '大类', navAirdrop: '空投项目', navBtt: 'BTT 新帖',
    filterLabel: '筛选', sortLabel: '排序', empty: '没有匹配的条目',
    tz: '北京时间',
    date: (o) => `${o.year}-${o.month}-${o.day}`,
    dateTime: (o) => `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`,
    friendsLabel: '友情链接:',
    friends: ['satloot 项目总览', '合约模拟器', 'BNBBANG 镜像宇宙', 'BTCBANG 比特宇宙', 'riskdesk 风控面板', 'satloot 游戏厅', 'satloot 工具站', 'TRX 质押收益计算器', '比特币测试网水龙头'],
    footerSync: (time) => `本页每 5 分钟同步一次,本次生成于 ${time}(北京时间)。只是信息汇总,不构成任何投资建议。空投与新币常伴随钓鱼站与仿冒钱包,交互前请核对官方渠道,不要向任何页面输入助记词或私钥。`,
    enumKind: (v) => v,
    enumMining: (v) => v,
    airdrop: {
      title: '空投雷达 · SatLoot Airdrop',
      description: (n, scan) => `${n} 个正在进行的加密空投项目:链、参与方式、阶段、热度证据与风险,按项目去重并标注首次发现日期。最近扫描 ${scan}(北京时间)。`,
      heroTitle: '正在进行的空投项目',
      heroLede: (src) => `由 <a href="${src}" rel="noopener">earn.satloot.com</a> 的空投雷达每日自动检索热门空投并存档:同一项目只出现一次,标注首次发现日期与上榜次数。字段取最近一次扫描的结论。`,
      langNote: '',
      statTotal: '项目总数', statNew: '本次新发现', statTestnet: '需测试网 BTC', statLastScan: '最近扫描(北京时间)', statNextScan: '下次扫描',
      tabAll: '全部', tabNew: '本次新发现', tabTestnet: '测试网 BTC',
      sortFirst: '最新发现', sortLast: '最近出现', sortCount: '上榜次数', sortName: '名称',
      searchPlaceholder: '搜索项目、链、参与方式…',
      emptyInitial: '雷达还没有产出任何项目,稍后再来。',
      footerNote: (src) => `数据来源:<a href="${src}" rel="noopener">earn.satloot.com 空投雷达</a>(AI 每日检索网页与社媒后整理)。机器可读:<a href="/data.json">data.json</a>。`,
      badgeTestnet: '测试网 BTC', badgeNew: '本次新发现', badgeSeen: (n) => `第 ${n} 次上榜`,
      rowChain: '链', rowParticipation: '参与方式', rowTestnet: '测试网', rowDeadline: '阶段 / 截止', rowBuzz: '热度证据', rowRisk: '风险',
      metaFirstTitle: '第一次被雷达扫到的日期', metaFirst: '首次发现', metaLast: '最近出现', metaSeen: (n) => `上榜 ${n} 次`,
    },
    btt: {
      title: 'BTT 新帖 · SatLoot Airdrop',
      description: (total, today, analyzed, check) => `bitcointalk 山寨币公告板(Altcoin Announcements)新帖监控:已收录 ${total} 帖,今日新帖 ${today},${analyzed} 帖带 AI 中文速览(类型、链、代币、分发方式、风险信号、评分)。最近巡检 ${check}(北京时间)。`,
      descriptionOffline: 'bitcointalk 山寨币公告板(Altcoin Announcements)新帖监控,带 AI 中文速览。',
      heroTitle: 'BTT 山寨板新帖',
      heroLede: (board, minutes) => `<a href="${board}" target="_blank" rel="noopener nofollow">bitcointalk Altcoin Announcements</a> 板块每 ${minutes} 分钟巡检一次:新帖立刻入库,AI 读首楼正文生成中文速览与 0–10 评分。评分只是粗筛,原帖为准。`,
      health: (n, err) => `巡检连续失败 ${n} 次,最新错误:${err}`,
      langNote: '',
      statTotal: '收录帖子', statToday: '今日新帖', statAnalyzed: '已生成速览', statPending: '速览排队中', statLastCheck: '最近巡检(北京时间)',
      tabAll: '全部', tabToday: '今日新帖', tabPow: 'PoW 矿币', tabCpu: 'CPU 可挖', tabAnalyzed: '有速览',
      sortFirst: '最新发现', sortScore: '评分', sortName: '标题',
      searchPlaceholder: '搜索标题、项目、链、代币、RandomX…',
      emptyOffline: 'BTT 监控尚未启动或还没有导出数据,稍后再来。',
      emptyNoRows: '监控已启动,还没有收录到帖子。',
      footerNote: (board) => `数据来源:<a href="${board}" target="_blank" rel="noopener nofollow">bitcointalk 山寨币公告板</a>,速览由 AI 只读首楼正文生成,可能有误。机器可读:<a href="/btt/data.json">btt/data.json</a>。`,
      badgeToday: '今日新帖', badgeScore: (s) => `评分 ${s}/10`, badgeCpu: 'CPU 可挖', badgePow: 'PoW',
      badgeFailed: '速览失败', badgeSkipped: '未做速览', badgeWait: '速览生成中',
      rowName: '项目', rowChain: '链', rowToken: '代币', rowDistribution: '募资 / 分发', rowMining: '挖矿', rowHighlights: '亮点', rowRedFlags: '风险信号', rowVerdict: '结论',
      pendingFailed: '首楼正文抓取或 AI 速览多次失败,请直接看原帖。', pendingSkipped: '这条没有生成速览。', pendingWait: 'AI 正在读首楼正文并生成中文速览,几分钟后刷新。',
      metaFound: '发现', metaAuthor: '楼主', metaPosted: '发帖', metaPost: (id) => `原帖 #${id}`,
    },
  },
  en: {
    code: 'en', htmlLang: 'en', ogLocale: 'en_US', ogLocaleAlt: 'zh_CN', dir: 'en/',
    switchLabel: '中文', switchLang: 'zh',
    brand: 'SatLoot · Airdrop Radar',
    navLabel: 'Sections', navAirdrop: 'Airdrops', navBtt: 'BTT threads',
    filterLabel: 'Filter', sortLabel: 'Sort', empty: 'Nothing matches',
    tz: 'UTC+8',
    date: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year}`,
    dateTime: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year} ${o.hour}:${o.minute}`,
    friendsLabel: 'Links:',
    friends: ['satloot project index', 'Futures simulator', 'BNBBANG mirror universe', 'BTCBANG Bitcoin universe', 'riskdesk risk panel', 'satloot arcade', 'satloot tools', 'TRX staking yield calculator', 'Bitcoin testnet faucet'],
    footerSync: (time) => `This page syncs every 5 minutes; this copy was generated ${time} (UTC+8). Information only, not investment advice. Airdrops and new coins attract phishing sites and fake wallets: verify official channels before interacting, and never enter a seed phrase or private key on any page.`,
    enumKind: (v) => BTT_KIND_EN[v] ?? v,
    enumMining: (v) => BTT_MINING_EN[v] ?? v,
    airdrop: {
      title: 'Airdrop Radar · SatLoot Airdrop',
      description: (n, scan) => `${n} ongoing crypto airdrop projects: chain, how to participate, stage, buzz evidence and risks, deduplicated by project with first-seen dates. Last scan ${scan} (UTC+8).`,
      heroTitle: 'Ongoing airdrop projects',
      heroLede: (src) => `The airdrop radar at <a href="${src}" rel="noopener">earn.satloot.com</a> searches for trending airdrops every day and archives them: each project appears once, tagged with its first-seen date and how many times it has been listed. Fields reflect the latest scan.`,
      langNote: 'Project descriptions are shown as archived (Chinese).',
      statTotal: 'Projects', statNew: 'New this scan', statTestnet: 'Need testnet BTC', statLastScan: 'Last scan (UTC+8)', statNextScan: 'Next scan',
      tabAll: 'All', tabNew: 'New this scan', tabTestnet: 'Testnet BTC',
      sortFirst: 'Newest found', sortLast: 'Last seen', sortCount: 'Times listed', sortName: 'Name',
      searchPlaceholder: 'Search project, chain, how to join…',
      emptyInitial: 'The radar has not produced any projects yet. Check back later.',
      footerNote: (src) => `Source: <a href="${src}" rel="noopener">earn.satloot.com airdrop radar</a> (an AI searches the web and social media daily and compiles the results). Machine-readable: <a href="/data.json">data.json</a>.`,
      badgeTestnet: 'Testnet BTC', badgeNew: 'New this scan', badgeSeen: (n) => `Listed ${n}×`,
      rowChain: 'Chain', rowParticipation: 'How to join', rowTestnet: 'Testnet', rowDeadline: 'Stage / deadline', rowBuzz: 'Buzz', rowRisk: 'Risk',
      metaFirstTitle: 'Date the radar first picked it up', metaFirst: 'First seen', metaLast: 'Last seen', metaSeen: (n) => `Listed ${n}×`,
    },
    btt: {
      title: 'BTT New Threads · SatLoot Airdrop',
      description: (total, today, analyzed, check) => `New-thread monitor for the bitcointalk Altcoin Announcements board: ${total} threads indexed, ${today} new today, ${analyzed} with an AI digest in Chinese (type, chain, token, distribution, red flags, score). Last check ${check} (UTC+8).`,
      descriptionOffline: 'New-thread monitor for the bitcointalk Altcoin Announcements board, with AI digests in Chinese.',
      heroTitle: 'New threads on BTT Altcoin Announcements',
      heroLede: (board, minutes) => `The <a href="${board}" target="_blank" rel="noopener nofollow">bitcointalk Altcoin Announcements</a> board is checked every ${minutes} minutes: new threads are indexed immediately and an AI reads the opening post to write a Chinese digest with a 0–10 score. The score is a rough filter; the original thread is authoritative.`,
      health: (n, err) => `The check has failed ${n} times in a row; latest error: ${err}`,
      langNote: 'AI digests are shown as archived (Chinese).',
      statTotal: 'Threads indexed', statToday: 'New today', statAnalyzed: 'Digests done', statPending: 'Digests queued', statLastCheck: 'Last check (UTC+8)',
      tabAll: 'All', tabToday: 'New today', tabPow: 'PoW coins', tabCpu: 'CPU-minable', tabAnalyzed: 'Has digest',
      sortFirst: 'Newest found', sortScore: 'Score', sortName: 'Title',
      searchPlaceholder: 'Search title, project, chain, token, RandomX…',
      emptyOffline: 'The BTT monitor has not started or has not exported data yet. Check back later.',
      emptyNoRows: 'The monitor is running but has not indexed any threads yet.',
      footerNote: (board) => `Source: <a href="${board}" target="_blank" rel="noopener nofollow">bitcointalk Altcoin Announcements</a>; digests are AI-generated from the opening post only and may be wrong. Machine-readable: <a href="/btt/data.json">btt/data.json</a>.`,
      badgeToday: 'New today', badgeScore: (s) => `Score ${s}/10`, badgeCpu: 'CPU-minable', badgePow: 'PoW',
      badgeFailed: 'Digest failed', badgeSkipped: 'No digest', badgeWait: 'Digest pending',
      rowName: 'Project', rowChain: 'Chain', rowToken: 'Token', rowDistribution: 'Raise / distribution', rowMining: 'Mining', rowHighlights: 'Highlights', rowRedFlags: 'Red flags', rowVerdict: 'Verdict',
      pendingFailed: 'Fetching the opening post or the AI digest failed repeatedly; read the original thread.', pendingSkipped: 'No digest was generated for this thread.', pendingWait: 'The AI is reading the opening post and writing a Chinese digest; refresh in a few minutes.',
      metaFound: 'Found', metaAuthor: 'OP', metaPosted: 'Posted', metaPost: (id) => `Thread #${id}`,
    },
  },
};

// ---------- 时间(全部按北京时间显示,格式按语言表) ----------
function partsIn(ts) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
const okTs = (ts) => ts != null && Number.isFinite(ts);
function fmtDate(ts, L) {
  if (!okTs(ts)) return '—';
  return L.date(partsIn(ts));
}
function fmtDateTime(ts, L) {
  if (!okTs(ts)) return '—';
  return L.dateTime(partsIn(ts));
}
function fmtIsoDate(ts) {
  const o = partsIn(ts);
  return `${o.year}-${o.month}-${o.day}`;
}
/** 北京时间今天 00:00 的时间戳 */
function todayStartMs(now) {
  const o = partsIn(now);
  return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day)) - 8 * 3600_000;
}
const isoToMs = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

// ---------- 文本 ----------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\x27/g, '&#39;');
}
/** 报告字段里偶尔带 markdown 加粗/反引号/列表符号,展示时去掉 */
function plain(s) {
  return String(s ?? '')
    .replace(/\*\*/g, '').replace(/`/g, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const has = (s) => {
  const p = plain(s);
  return p !== '' && p !== '—' && p !== '无' && p !== '未提及';
};
function dlRows(fields) {
  return fields
    .filter(([, v]) => has(v))
    .map(([k, v, cls]) => `<div class="row${cls ? ` ${cls}` : ''}"><dt>${esc(k)}</dt><dd>${esc(plain(v))}</dd></div>`)
    .join('');
}

// ---------- 空投项目卡片 ----------
function renderAirdropCard(r, latestOkTs, L) {
  const T = L.airdrop;
  const isNew = latestOkTs != null && r.firstSeenTs >= latestOkTs;
  const testnet = r.testnetFlag === 'yes';
  const badges = [];
  if (testnet) badges.push(`<span class="badge badge-testnet">${T.badgeTestnet}</span>`);
  if (isNew) badges.push(`<span class="badge badge-new">${T.badgeNew}</span>`);
  if (r.seenCount > 1) badges.push(`<span class="badge badge-dim">${T.badgeSeen(r.seenCount)}</span>`);
  const dl = dlRows([
    [T.rowChain, r.chain],
    [T.rowParticipation, r.participation],
    [T.rowTestnet, testnet ? r.testnetDetail : null],
    [T.rowDeadline, r.deadline],
    [T.rowBuzz, r.buzz],
    [T.rowRisk, r.risk, 'row-risk'],
  ]);
  const search = [r.name, r.chain, r.participation, r.deadline, r.buzz, r.risk, r.testnetDetail]
    .map(plain).join(' ').toLowerCase();
  return `<article class="card" data-testnet="${testnet ? 1 : 0}" data-new="${isNew ? 1 : 0}" data-first="${r.firstSeenTs}" data-last="${r.lastSeenTs}" data-count="${r.seenCount}" data-search="${esc(search)}">
  <header class="card-head">
    <h2>${esc(r.name)}</h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  <dl>${dl}</dl>
  <footer class="card-meta">
    <span title="${T.metaFirstTitle}">${T.metaFirst} <time datetime="${fmtIsoDate(r.firstSeenTs)}">${fmtDate(r.firstSeenTs, L)}</time></span>
    <span>${T.metaLast} <time datetime="${fmtIsoDate(r.lastSeenTs)}">${fmtDate(r.lastSeenTs, L)}</time></span>
    <span>${T.metaSeen(r.seenCount)}</span>
  </footer>
</article>`;
}

// ---------- BTT 新帖卡片 ----------
/** PoW 矿币 / CPU 可挖 两个分类:新速览有 mining 字段;老速览与标题靠关键词兜底 */
function miningFlags(p) {
  const a = p.analysisStatus === 'done' && p.analysis ? p.analysis : null;
  const blob = [p.title, a?.kind, a?.chain, a?.token, a?.distribution, a?.highlights, a?.verdict, a?.mining].map(plain).join(' ');
  const mining = plain(a?.mining || '');
  const pow = /矿币|挖矿|\bPoW\b|proof[\s-]*of[\s-]*work|\b(mine|mined|mining|minable|mineable)\b/i.test(blob)
    || /CPU|GPU|ASIC/i.test(mining);
  const cpu = pow && (/CPU/i.test(mining) || /\bCPU\b|RandomX|yescrypt|cpu[\s-]?(min|挖)|CPU\s*可挖|CPU\s*挖/i.test(blob));
  return { pow, cpu, mining };
}
function scoreClass(score) {
  if (score == null) return 'badge-dim';
  if (score >= 7) return 'badge-new';
  if (score <= 3) return 'badge-low';
  return 'badge-mid';
}
function renderBttCard(p, todayMs, L) {
  const T = L.btt;
  const a = p.analysisStatus === 'done' && p.analysis ? p.analysis : null;
  const isToday = !p.seeded && okTs(p.firstSeenTs) && p.firstSeenTs >= todayMs;
  const score = a && Number.isFinite(a.score) ? a.score : null;
  const { pow, cpu, mining } = miningFlags(p);
  const badges = [];
  if (isToday) badges.push(`<span class="badge badge-new">${T.badgeToday}</span>`);
  if (a) {
    if (score != null) badges.push(`<span class="badge ${scoreClass(score)}">${T.badgeScore(score)}</span>`);
    if (has(a.kind)) badges.push(`<span class="badge badge-dim">${esc(L.enumKind(plain(a.kind)))}</span>`);
    if (cpu) badges.push(`<span class="badge badge-testnet">${T.badgeCpu}</span>`);
    else if (pow) badges.push(`<span class="badge badge-dim">${T.badgePow}</span>`);
  } else if (p.analysisStatus === 'failed') {
    badges.push(`<span class="badge badge-low">${T.badgeFailed}</span>`);
  } else if (p.analysisStatus === 'skipped') {
    badges.push(`<span class="badge badge-dim">${T.badgeSkipped}</span>`);
  } else {
    badges.push(`<span class="badge badge-dim badge-wait">${T.badgeWait}</span>`);
  }
  const body = a
    ? `<dl>${dlRows([
        [T.rowName, a.name],
        [T.rowChain, a.chain],
        [T.rowToken, a.token],
        [T.rowDistribution, a.distribution],
        [T.rowMining, /不可挖|非矿币/.test(mining) ? null : L.enumMining(mining)],
        [T.rowHighlights, a.highlights],
        [T.rowRedFlags, a.red_flags, 'row-risk'],
        [T.rowVerdict, a.verdict, 'row-verdict'],
      ])}</dl>`
    : `<p class="pending">${p.analysisStatus === 'failed' ? T.pendingFailed : p.analysisStatus === 'skipped' ? T.pendingSkipped : T.pendingWait}</p>`;
  const meta = [
    `<span>${T.metaFound} <time datetime="${okTs(p.firstSeenTs) ? new Date(p.firstSeenTs).toISOString() : ''}">${fmtDateTime(p.firstSeenTs, L)}</time></span>`,
    p.author ? `<span>${T.metaAuthor} ${esc(p.author)}</span>` : '',
    p.postedAt ? `<span>${T.metaPosted} ${esc(p.postedAt)}</span>` : '',
    `<a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${T.metaPost(esc(p.topicId))}</a>`,
  ].filter(Boolean).join('');
  const search = [p.title, p.author, a?.name, a?.kind, a?.chain, a?.token, a?.distribution, a?.highlights, a?.red_flags, a?.verdict]
    .map(plain).join(' ').toLowerCase();
  return `<article class="card" data-today="${isToday ? 1 : 0}" data-analyzed="${a ? 1 : 0}" data-pow="${pow ? 1 : 0}" data-cpu="${cpu ? 1 : 0}" data-first="${okTs(p.firstSeenTs) ? p.firstSeenTs : 0}" data-score="${score ?? -1}" data-search="${esc(search)}">
  <header class="card-head">
    <h2><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${esc(p.title)}</a></h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  ${body}
  <footer class="card-meta">${meta}</footer>
</article>`;
}

// ---------- 页面拼装 ----------
/** 每个页面在两种语言下的路径(相对站根,不带前导 /) */
const PAGE_PATH = { airdrop: '', btt: 'btt/' };
const pageHref = (page, L) => `/${L.dir}${PAGE_PATH[page]}`;
const pageUrl = (page, L) => `${SITE_URL}${L.dir}${PAGE_PATH[page]}`;

function nav(active, counts, L) {
  const item = (href, key, label, n) =>
    `<a class="cat" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}<small>${n}</small></a>`;
  const other = LOCALES[L.switchLang];
  return `<div class="navwrap"><nav class="cats" aria-label="${L.navLabel}">${item(pageHref('airdrop', L), 'airdrop', L.navAirdrop, counts.airdrop)}${item(pageHref('btt', L), 'btt', L.navBtt, counts.btt)}</nav>`
    + `<a class="lang-switch" href="${pageHref(active, other)}" hreflang="${other.htmlLang}" lang="${other.htmlLang}" data-lang="${other.code}">${L.switchLabel}</a></div>`;
}
function stat(value, label) {
  return `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}
function tab(filter, label, n, pressed) {
  return `<button class="tab" type="button" data-filter="${filter}" aria-pressed="${pressed ? 'true' : 'false'}">${label}<small>${n}</small></button>`;
}
function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}
/** 两种语言共用的页面变量:hreflang、og:locale、友链、页脚、首访跳转脚本(只在中文页) */
function pageCommon(page, L, generatedTs) {
  const en = LOCALES.en;
  const zh = LOCALES.zh;
  // 中文页首访:没记过选择(或记的是 en)且浏览器语言不是中文就跳英文版;爬虫不跳,免得搜索引擎把 / 当成跳转页
  const headScript = L.code === 'zh'
    ? `<script>try{var l=localStorage.getItem('lang');if((l==='en'||(!l&&!/^zh/i.test(navigator.language||'')))&&!/bot|crawl|spider/i.test(navigator.userAgent))location.replace('${pageHref(page, en)}')}catch(e){}</script>\n`
    : '';
  return {
    HTML_LANG: L.htmlLang,
    HEAD_SCRIPT: headScript,
    CANONICAL: pageUrl(page, L),
    URL_ZH: pageUrl(page, zh),
    URL_EN: pageUrl(page, en),
    OG_LOCALE: L.ogLocale,
    OG_LOCALE_ALT: L.ogLocaleAlt,
    BRAND: L.brand,
    LANG_NOTE: L[page].langNote ? `<p class="langnote">${esc(L[page].langNote)}</p>` : '',
    T_FILTER: L.filterLabel,
    T_SORT: L.sortLabel,
    T_EMPTY: L.empty,
    FRIENDS: `${esc(L.friendsLabel)} ` + FRIEND_URLS.map((href, i) => `<a href="${href}" rel="noopener">${esc(L.friends[i])}</a>`).join(' · '),
    FOOTER_SYNC: L.footerSync(`<time datetime="${new Date(generatedTs).toISOString()}">${fmtDateTime(generatedTs, L)}</time>`),
  };
}

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

async function main() {
  const [projects, status, reports, btt] = await Promise.all([
    getJson('/api/airdrop/projects?limit=1000', 'projects.json'),
    getJson('/api/airdrop/status', 'status.json'),
    getJson('/api/airdrop/reports?limit=10', 'reports.json'),
    loadBtt(),
  ]);
  const rows = Array.isArray(projects?.rows) ? projects.rows : [];
  if (projects?.mode !== 'rollup') throw new Error(`unexpected projects mode: ${projects?.mode}`);

  // "本次新发现" = 首见时间落在最近一次成功扫描上。以成功报告为准,失败的扫描不算。
  const okReportTs = (reports?.rows ?? []).filter((x) => x.ok === 1 && Number.isFinite(x.ts)).map((x) => x.ts);
  let latestOkTs = okReportTs.length ? Math.max(...okReportTs) : null;
  if (latestOkTs == null && status?.lastOk && Number.isFinite(status?.lastRunTs)) latestOkTs = status.lastRunTs;

  rows.sort((a, b) => b.firstSeenTs - a.firstSeenTs || b.seenCount - a.seenCount || a.name.localeCompare(b.name, 'zh'));
  const testnetCount = rows.filter((r) => r.testnetFlag === 'yes').length;
  const newCount = latestOkTs == null ? 0 : rows.filter((r) => r.firstSeenTs >= latestOkTs).length;
  const generatedTs = Date.now();
  const todayMs = todayStartMs(generatedTs);

  const bttRows = Array.isArray(btt?.rows) ? btt.rows.slice() : [];
  bttRows.sort((a, b) => (b.firstSeenTs || 0) - (a.firstSeenTs || 0) || (b.topicId || 0) - (a.topicId || 0));
  const bttToday = bttRows.filter((p) => !p.seeded && okTs(p.firstSeenTs) && p.firstSeenTs >= todayMs).length;
  const bttAnalyzed = bttRows.filter((p) => p.analysisStatus === 'done' && p.analysis).length;
  const bttPow = bttRows.filter((p) => miningFlags(p).pow).length;
  const bttCpu = bttRows.filter((p) => miningFlags(p).cpu).length;
  const bttTotal = btt ? (Number.isFinite(btt.count) ? btt.count : bttRows.length) : 0;
  const bttLastOk = isoToMs(btt?.lastOkAt);
  const bttMinutes = btt?.checkEverySec ? Math.round(btt.checkEverySec / 60) : 5;
  const counts = { airdrop: rows.length, btt: bttTotal };

  const template = await fs.readFile(path.join(__dirname, 'template.html'), 'utf8');

  // ---- 空投项目页 ----
  const airdropPage = (L) => {
    const T = L.airdrop;
    return render(template, {
      ...pageCommon('airdrop', L, generatedTs),
      PAGE_TITLE: T.title,
      DESCRIPTION: T.description(rows.length, fmtDateTime(latestOkTs, L)),
      NAV: nav('airdrop', counts, L),
      HERO_TITLE: T.heroTitle,
      HERO_LEDE: T.heroLede(SOURCE_URL),
      STATS: [
        stat(rows.length, T.statTotal),
        stat(newCount, T.statNew),
        stat(testnetCount, T.statTestnet),
        stat(fmtDateTime(latestOkTs, L), T.statLastScan),
        stat(fmtDateTime(status?.nextRunTs, L), T.statNextScan),
      ].join(''),
      TABS: [tab('all', T.tabAll, rows.length, true), tab('new', T.tabNew, newCount), tab('testnet', T.tabTestnet, testnetCount)].join(''),
      SORT_OPTIONS: `<option value="first">${T.sortFirst}</option><option value="last">${T.sortLast}</option><option value="count">${T.sortCount}</option><option value="name">${T.sortName}</option>`,
      SEARCH_PLACEHOLDER: T.searchPlaceholder,
      CARDS: rows.length
        ? rows.map((r) => renderAirdropCard(r, latestOkTs, L)).join('\n')
        : `<p class="empty-initial">${T.emptyInitial}</p>`,
      FOOTER_NOTE: T.footerNote(SOURCE_URL),
    });
  };

  // ---- BTT 新帖页 ----
  const bttPage = (L) => {
    const T = L.btt;
    let bttCards;
    if (!btt) {
      bttCards = `<p class="empty-initial">${T.emptyOffline}</p>`;
    } else if (!bttRows.length) {
      bttCards = `<p class="empty-initial">${T.emptyNoRows}</p>`;
    } else {
      bttCards = bttRows.map((p) => renderBttCard(p, todayMs, L)).join('\n');
    }
    const bttHealth = btt && btt.failStreak > 0 ? `<span class="warn">${T.health(btt.failStreak, esc(btt.lastError || ''))}</span>` : '';
    return render(template, {
      ...pageCommon('btt', L, generatedTs),
      PAGE_TITLE: T.title,
      DESCRIPTION: btt ? T.description(bttTotal, bttToday, bttAnalyzed, fmtDateTime(bttLastOk, L)) : T.descriptionOffline,
      NAV: nav('btt', counts, L),
      HERO_TITLE: T.heroTitle,
      HERO_LEDE: T.heroLede(BTT_BOARD_URL, bttMinutes) + bttHealth,
      STATS: [
        stat(btt ? bttTotal : '—', T.statTotal),
        stat(btt ? bttToday : '—', T.statToday),
        stat(btt ? bttAnalyzed : '—', T.statAnalyzed),
        stat(btt && btt.pendingCount ? btt.pendingCount : 0, T.statPending),
        stat(fmtDateTime(bttLastOk, L), T.statLastCheck),
      ].join(''),
      TABS: [tab('all', T.tabAll, bttRows.length, true), tab('today', T.tabToday, bttToday), tab('pow', T.tabPow, bttPow), tab('cpu', T.tabCpu, bttCpu), tab('analyzed', T.tabAnalyzed, bttAnalyzed)].join(''),
      SORT_OPTIONS: `<option value="first">${T.sortFirst}</option><option value="score">${T.sortScore}</option><option value="name">${T.sortName}</option>`,
      SEARCH_PLACEHOLDER: T.searchPlaceholder,
      CARDS: bttCards,
      FOOTER_NOTE: T.footerNote(BTT_BOARD_URL),
    });
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const L of [LOCALES.zh, LOCALES.en]) {
    await writeAtomic(path.join(OUT_DIR, L.dir, 'index.html'), airdropPage(L));
    await writeAtomic(path.join(OUT_DIR, L.dir, 'btt', 'index.html'), bttPage(L));
  }
  await writeAtomic(path.join(OUT_DIR, 'data.json'), JSON.stringify({
    generatedAt: new Date(generatedTs).toISOString(),
    latestScanAt: latestOkTs == null ? null : new Date(latestOkTs).toISOString(),
    nextScanAt: Number.isFinite(status?.nextRunTs) ? new Date(status.nextRunTs).toISOString() : null,
    source: SOURCE_URL,
    count: rows.length,
    rows,
  }, null, 1));
  if (btt) await writeAtomic(path.join(OUT_DIR, 'btt', 'data.json'), JSON.stringify(btt, null, 1));
  await writeAtomic(path.join(OUT_DIR, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);

  // sitemap:四个 URL,每个都带同页另一语言的 hreflang alternate(x-default 指中文)
  const smUrl = (page, L, lastmod, freq) => {
    const alt = `<xhtml:link rel="alternate" hreflang="zh-CN" href="${pageUrl(page, LOCALES.zh)}"/>`
      + `<xhtml:link rel="alternate" hreflang="en" href="${pageUrl(page, LOCALES.en)}"/>`
      + `<xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(page, LOCALES.zh)}"/>`;
    return `  <url><loc>${pageUrl(page, L)}</loc>${alt}<lastmod>${fmtIsoDate(lastmod)}</lastmod><changefreq>${freq}</changefreq></url>\n`;
  };
  await writeAtomic(path.join(OUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    smUrl('airdrop', LOCALES.zh, latestOkTs ?? generatedTs, 'daily') +
    smUrl('airdrop', LOCALES.en, latestOkTs ?? generatedTs, 'daily') +
    smUrl('btt', LOCALES.zh, bttLastOk ?? generatedTs, 'hourly') +
    smUrl('btt', LOCALES.en, bttLastOk ?? generatedTs, 'hourly') +
    `</urlset>\n`);
  console.log(`[airdrop-site] airdrop ${rows.length} (${testnetCount} testnet, ${newCount} new), btt ${btt ? `${bttTotal} posts (${bttToday} today, ${bttAnalyzed} analyzed)` : 'unavailable'} -> ${OUT_DIR} (zh + en)`);
}

main().catch((err) => {
  console.error('[airdrop-site] build failed:', err?.message || err);
  process.exit(1);
});
