#!/usr/bin/env node
// airdrop.satloot.com 静态页生成器。三个大类 × 两种语言:
//   /          空投项目(zh-CN)—— riskdesk 侧车(127.0.0.1:5177,本机直连即站主)的空投雷达存档
//   /btt/      BTT 新帖(zh-CN)—— btt/btt_monitor.py 导出的 export.json(bitcointalk 山寨板新帖 + grok 中文速览)
//   /celeb/    名人发币(zh-CN)—— celeb/celeb_monitor.py 导出的 export.json(名人/政客发币新闻事件 + grok 中文速览 + 去哪订阅)
//   /en/  /en/btt/  /en/celeb/  同一模板按 LOCALES.en 渲染的英文壳;项目描述数据本身是中文来源,英文页原样保留
// 由 systemd 定时器每 5 分钟跑一次;任一数据源挂了就保留上一版文件,不会把站点写空。
//
// 环境变量:
//   AIRDROP_API_BASE     侧车地址,默认 http://127.0.0.1:5177
//   AIRDROP_BTT_JSON     BTT 导出文件,默认 /var/lib/btt-monitor/export.json(不存在则 BTT 页显示未启动)
//   AIRDROP_CELEB_JSON   名人发币导出文件,默认 /var/lib/celeb-monitor/export.json(不存在则该页显示未启动)
//   AIRDROP_OUT_DIR      输出目录,默认 ./dist
//   AIRDROP_FIXTURE_DIR  本地测试:从该目录读 projects.json / status.json / reports.json / btt-export.json / celeb-export.json,不联网
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.AIRDROP_API_BASE || 'http://127.0.0.1:5177').replace(/\/$/, '');
const BTT_JSON = process.env.AIRDROP_BTT_JSON || '/var/lib/btt-monitor/export.json';
const CELEB_JSON = process.env.AIRDROP_CELEB_JSON || '/var/lib/celeb-monitor/export.json';
const OUT_DIR = process.env.AIRDROP_OUT_DIR || path.join(__dirname, 'dist');
const FIXTURE_DIR = process.env.AIRDROP_FIXTURE_DIR || null;
const SITE_URL = 'https://airdrop.satloot.com/';
const SOURCE_URL = 'https://earn.satloot.com/app/#/airdrop';
const BTT_BOARD_URL = 'https://bitcointalk.org/index.php?board=159.0';
const TZ = 'Asia/Shanghai';
const OG_IMAGE = `${SITE_URL}og.png`;          // static/og.png(1200×630,tools/make-og.mjs 生成),每次生成时原样复制到输出目录
const ORG_URL = 'https://satloot.com/';
const GITHUB_URL = 'https://github.com/q3579338';
const STATIC_DIR = path.join(__dirname, 'static');

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

/** 监控导出是可选数据源:没有就返回 null,页面照常生成 */
async function loadExport(label, fixtureName, file) {
  const f = FIXTURE_DIR ? path.join(FIXTURE_DIR, fixtureName) : file;
  try {
    return JSON.parse(await fs.readFile(f, 'utf8'));
  } catch (err) {
    console.warn(`[airdrop-site] ${label} export unavailable (${f}): ${err?.message || err}`);
    return null;
  }
}
const loadBtt = () => loadExport('BTT', 'btt-export.json', BTT_JSON);
const loadCeleb = () => loadExport('celeb', 'celeb-export.json', CELEB_JSON);

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
// 名人发币速览的 status 枚举(见 celeb/celeb_monitor.py)
const CELEB_STATUS_EN = { '传闻': 'Rumor', '本人确认': 'Confirmed', '已上线': 'Live', '已辟谣': 'Denied' };

const LOCALES = {
  zh: {
    code: 'zh', htmlLang: 'zh-CN', ogLocale: 'zh_CN', ogLocaleAlt: 'en_US', dir: '',
    switchLabel: 'EN', switchLang: 'en',
    brand: 'SatLoot · 空投雷达',
    siteName: 'SatLoot 空投雷达',
    navLabel: '大类', navAirdrop: '空投项目', navBtt: 'BTT 新帖', navCeleb: '名人发币',
    filterLabel: '筛选', sortLabel: '排序', empty: '没有匹配的条目',
    tz: '北京时间',
    date: (o) => `${o.year}-${o.month}-${o.day}`,
    dateTime: (o) => `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`,
    friendsLabel: '友情链接:',
    friends: ['satloot 项目总览', '合约模拟器', 'BNBBANG 镜像宇宙', 'BTCBANG 比特宇宙', 'riskdesk 风控面板', 'satloot 游戏厅', 'satloot 工具站', 'TRX 质押收益计算器', '比特币测试网水龙头'],
    footerSync: (time) => `本页每 5 分钟同步一次,本次生成于 ${time}(北京时间)。只是信息汇总,不构成任何投资建议。空投与新币常伴随钓鱼站与仿冒钱包,交互前请核对官方渠道,不要向任何页面输入助记词或私钥。`,
    enumKind: (v) => v,
    enumMining: (v) => v,
    enumStatus: (v) => v,
    airdrop: {
      title: '空投雷达 · SatLoot Airdrop',
      description: (n, scan) => `${n} 个正在进行的加密空投项目:链、参与方式、阶段、热度证据与风险,按项目去重并标注首次发现日期与上榜次数。最近扫描 ${scan}(北京时间)。`,
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
      descriptionOffline: 'bitcointalk 山寨币公告板(Altcoin Announcements)新帖监控:新帖立刻入库,AI 读首楼正文生成中文速览(类型、链、代币、分发方式、风险信号、评分)。',
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
    celeb: {
      title: '名人发币 · SatLoot Airdrop',
      description: (total, strong, today, check) => `名人、政客、网红发币新闻监控:已收录 ${total} 个事件(${strong} 个点名命中),今日新增 ${today}。消息一出就推送,并给出该去订阅的渠道,赶在空投名单截止前进场。最近巡检 ${check}(北京时间)。`,
      descriptionOffline: '名人、政客、网红发币新闻监控:Google News 与币媒 RSS 每 10 分钟巡检,命中即推送,AI 速览给出空投规则与该去订阅的渠道。',
      heroTitle: '名人发币雷达',
      heroLede: (minutes, n) => `Google News 与 The Block / CoinDesk / Cointelegraph / Decrypt 的 RSS 每 ${minutes} 分钟巡检一次,标题里同时出现「发币动词 + 代币词 + 人名或身份词」就算命中:点名名单 ${n} 人为强命中,只有身份词(celebrity / senator / rapper…)为疑似。同一人物 7 天内的报道合并为一个事件,只在第一篇推送微信。LAPTOP 的空投按 Substack 订阅者截名单、WSJ 提前两天报道,这一页就是为了下一次能赶上那两天。`,
      health: (n, err) => `巡检连续失败 ${n} 次,最新错误:${err}`,
      langNote: '',
      statTotal: '事件总数', statStrong: '点名命中', statToday: '今日新增', statArticles: '报道总数', statLastCheck: '最近巡检(北京时间)',
      tabAll: '全部', tabStrong: '点名命中', tabToday: '今日新增', tabWeek: '7 天内', tabAnalyzed: '有速览',
      sortLast: '最近报道', sortFirst: '最早发现', sortMentions: '报道数', sortScore: '评分', sortName: '人物',
      searchPlaceholder: '搜索人物、代币、链、Substack…',
      emptyOffline: '名人发币监控尚未启动或还没有导出数据,稍后再来。',
      emptyNoRows: '监控已启动,还没有命中任何事件。',
      footerNote: () => `数据来源:Google News RSS 检索 + The Block / CoinDesk / Cointelegraph / Decrypt RSS;速览由 AI 只读标题与摘要生成,可能有误,「去哪订阅」一栏若标注推测请自行核实。机器可读:<a href="/celeb/data.json">celeb/data.json</a>。`,
      badgeStrong: '点名', badgeWeak: '疑似', badgeToday: '今日新增', badgeMentions: (n) => `${n} 篇报道`, badgeScore: (s) => `评分 ${s}/10`,
      badgeFailed: '速览失败', badgeSkipped: '未做速览', badgeWait: '速览生成中', badgePushed: '已推微信',
      rowPerson: '人物', rowRole: '身份', rowToken: '代币', rowChain: '链', rowDate: '日期', rowStatus: '状态', rowAirdrop: '空投规则', rowSubscribe: '去哪订阅', rowCredibility: '可信度', rowVerdict: '结论',
      rowSubscribeHint: '订阅提示',
      pendingFailed: 'AI 速览多次失败,请直接看报道。', pendingSkipped: '这条没有生成速览。', pendingWait: 'AI 正在读报道生成中文速览,几分钟后刷新。',
      metaFirst: '首见', metaLast: '最近', metaSource: '来源', moreArticles: (n) => `其余 ${n} 篇报道`,
    },
  },
  en: {
    code: 'en', htmlLang: 'en', ogLocale: 'en_US', ogLocaleAlt: 'zh_CN', dir: 'en/',
    switchLabel: '中文', switchLang: 'zh',
    brand: 'SatLoot · Airdrop Radar',
    siteName: 'SatLoot Airdrop Radar',
    navLabel: 'Sections', navAirdrop: 'Airdrops', navBtt: 'BTT threads', navCeleb: 'Celebrity coins',
    filterLabel: 'Filter', sortLabel: 'Sort', empty: 'Nothing matches',
    tz: 'UTC+8',
    date: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year}`,
    dateTime: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year} ${o.hour}:${o.minute}`,
    friendsLabel: 'Links:',
    friends: ['satloot project index', 'Futures simulator', 'BNBBANG mirror universe', 'BTCBANG Bitcoin universe', 'riskdesk risk panel', 'satloot arcade', 'satloot tools', 'TRX staking yield calculator', 'Bitcoin testnet faucet'],
    footerSync: (time) => `This page syncs every 5 minutes; this copy was generated ${time} (UTC+8). Information only, not investment advice. Airdrops and new coins attract phishing sites and fake wallets: verify official channels before interacting, and never enter a seed phrase or private key on any page.`,
    enumKind: (v) => BTT_KIND_EN[v] ?? v,
    enumMining: (v) => BTT_MINING_EN[v] ?? v,
    enumStatus: (v) => CELEB_STATUS_EN[v] ?? v,
    airdrop: {
      title: 'Airdrop Radar · SatLoot Airdrop',
      description: (n, scan) => `${n} ongoing crypto airdrops: chain, how to join, stage, buzz and risks, deduplicated by project with first-seen dates. Last scan ${scan} (UTC+8).`,
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
      description: (total, today, analyzed, check) => `New threads on the bitcointalk Altcoin Announcements board: ${total} indexed, ${today} new today, ${analyzed} with AI digests. Last check ${check} (UTC+8).`,
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
    celeb: {
      title: 'Celebrity Coin Radar · SatLoot Airdrop',
      description: (total, strong, today, check) => `News monitor for celebrity, politician and influencer token launches: ${total} events indexed (${strong} watchlist hits), ${today} new today. Each event is pushed the moment it breaks, with the channel to subscribe to before the airdrop snapshot. Last check ${check} (UTC+8).`,
      descriptionOffline: 'News monitor for celebrity, politician and influencer token launches: Google News and crypto-media RSS checked every 10 minutes, pushed on hit, with an AI digest of airdrop rules and where to subscribe.',
      heroTitle: 'Celebrity coin radar',
      heroLede: (minutes, n) => `Google News plus The Block / CoinDesk / Cointelegraph / Decrypt RSS are checked every ${minutes} minutes. A headline counts when it combines a launch verb, a token word and a person or role word: the ${n}-name watchlist is a strong hit, a bare role word (celebrity / senator / rapper…) is tentative. Reports about the same person within 7 days merge into one event, pushed once. LAPTOP's airdrop list was cut from Substack subscribers two days after the WSJ scoop; this page exists to catch those two days next time.`,
      health: (n, err) => `The check has failed ${n} times in a row; latest error: ${err}`,
      langNote: 'AI digests are shown as archived (Chinese).',
      statTotal: 'Events', statStrong: 'Watchlist hits', statToday: 'New today', statArticles: 'Articles', statLastCheck: 'Last check (UTC+8)',
      tabAll: 'All', tabStrong: 'Watchlist', tabToday: 'New today', tabWeek: 'Last 7 days', tabAnalyzed: 'Has digest',
      sortLast: 'Latest report', sortFirst: 'First seen', sortMentions: 'Reports', sortScore: 'Score', sortName: 'Person',
      searchPlaceholder: 'Search person, token, chain, Substack…',
      emptyOffline: 'The celebrity coin monitor has not started or has not exported data yet. Check back later.',
      emptyNoRows: 'The monitor is running but has not matched any event yet.',
      footerNote: () => `Sources: Google News RSS searches plus The Block / CoinDesk / Cointelegraph / Decrypt RSS; digests are AI-generated from headlines and summaries only and may be wrong. Verify any "where to subscribe" line marked as a guess. Machine-readable: <a href="/celeb/data.json">celeb/data.json</a>.`,
      badgeStrong: 'Watchlist', badgeWeak: 'Tentative', badgeToday: 'New today', badgeMentions: (n) => `${n} reports`, badgeScore: (s) => `Score ${s}/10`,
      badgeFailed: 'Digest failed', badgeSkipped: 'No digest', badgeWait: 'Digest pending', badgePushed: 'Pushed',
      rowPerson: 'Person', rowRole: 'Role', rowToken: 'Token', rowChain: 'Chain', rowDate: 'Date', rowStatus: 'Status', rowAirdrop: 'Airdrop rules', rowSubscribe: 'Where to subscribe', rowCredibility: 'Credibility', rowVerdict: 'Verdict',
      rowSubscribeHint: 'Subscribe hint',
      pendingFailed: 'The AI digest failed repeatedly; read the reports directly.', pendingSkipped: 'No digest was generated for this event.', pendingWait: 'The AI is reading the reports and writing a Chinese digest; refresh in a few minutes.',
      metaFirst: 'First seen', metaLast: 'Latest', metaSource: 'Source', moreArticles: (n) => `${n} more reports`,
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

// ---------- 名人发币事件卡片 ----------
function renderCelebCard(s, todayMs, weekMs, L) {
  const T = L.celeb;
  const a = s.analysisStatus === 'done' && s.analysis ? s.analysis : null;
  const strong = s.level === 'strong';
  const isToday = !s.seeded && okTs(s.firstSeenTs) && s.firstSeenTs >= todayMs;
  const inWeek = okTs(s.lastSeenTs) && s.lastSeenTs >= weekMs;
  const score = a && Number.isFinite(a.score) ? a.score : null;
  const person = plain(a?.person) || s.person || '';
  const ticker = s.ticker ? `$${s.ticker}` : '';
  const heading = [person, ticker].filter(Boolean).join(' · ') || s.title;
  const badges = [];
  badges.push(strong ? `<span class="badge badge-testnet">${T.badgeStrong}</span>` : `<span class="badge badge-dim">${T.badgeWeak}</span>`);
  if (isToday) badges.push(`<span class="badge badge-new">${T.badgeToday}</span>`);
  if (a) {
    if (score != null) badges.push(`<span class="badge ${scoreClass(score)}">${T.badgeScore(score)}</span>`);
    if (has(a.status)) badges.push(`<span class="badge badge-dim">${esc(L.enumStatus(plain(a.status)))}</span>`);
  } else if (s.analysisStatus === 'failed') {
    badges.push(`<span class="badge badge-low">${T.badgeFailed}</span>`);
  } else if (s.analysisStatus === 'skipped') {
    badges.push(`<span class="badge badge-dim">${T.badgeSkipped}</span>`);
  } else {
    badges.push(`<span class="badge badge-dim badge-wait">${T.badgeWait}</span>`);
  }
  if (s.mentions > 1) badges.push(`<span class="badge badge-dim">${T.badgeMentions(s.mentions)}</span>`);
  if (s.pushedWx) badges.push(`<span class="badge badge-dim">${T.badgePushed}</span>`);
  const body = a
    ? `<dl>${dlRows([
        [T.rowRole, a.role],
        [T.rowToken, a.token],
        [T.rowChain, a.chain],
        [T.rowDate, a.launch_date],
        [T.rowAirdrop, a.airdrop],
        [T.rowSubscribe, a.subscribe, 'row-verdict'],
        [T.rowCredibility, a.credibility],
        [T.rowVerdict, a.verdict, 'row-verdict'],
      ])}</dl>`
    : `<dl>${dlRows([[T.rowSubscribeHint, s.subscribe, 'row-verdict']])}</dl><p class="pending">${s.analysisStatus === 'failed' ? T.pendingFailed : s.analysisStatus === 'skipped' ? T.pendingSkipped : T.pendingWait}</p>`;
  const arts = Array.isArray(s.articles) ? s.articles : [];
  const others = arts.filter((x) => x.url !== s.url).slice(0, 5);
  const more = others.length
    ? `<details class="more"><summary>${T.moreArticles(Math.max(s.mentions - 1, others.length))}</summary><ul>${others.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener nofollow">${esc(x.title)}</a> <small>${esc(x.source || '')}</small></li>`).join('')}</ul></details>`
    : '';
  const meta = [
    `<span>${T.metaFirst} <time datetime="${okTs(s.firstSeenTs) ? new Date(s.firstSeenTs).toISOString() : ''}">${fmtDateTime(s.firstSeenTs, L)}</time></span>`,
    `<span>${T.metaLast} <time datetime="${okTs(s.lastSeenTs) ? new Date(s.lastSeenTs).toISOString() : ''}">${fmtDateTime(s.lastSeenTs, L)}</time></span>`,
    s.source ? `<span>${T.metaSource} ${esc(s.source)}</span>` : '',
  ].filter(Boolean).join('');
  const search = [s.person, s.ticker, s.title, s.source, s.subscribe, a?.person, a?.role, a?.token, a?.chain, a?.airdrop, a?.subscribe, a?.verdict, ...arts.map((x) => x.title)]
    .map(plain).join(' ').toLowerCase();
  return `<article class="card" data-strong="${strong ? 1 : 0}" data-today="${isToday ? 1 : 0}" data-week="${inWeek ? 1 : 0}" data-analyzed="${a ? 1 : 0}" data-first="${okTs(s.firstSeenTs) ? s.firstSeenTs : 0}" data-last="${okTs(s.lastSeenTs) ? s.lastSeenTs : 0}" data-mentions="${s.mentions || 0}" data-score="${score ?? -1}" data-search="${esc(search)}">
  <header class="card-head">
    <h2>${esc(heading)}</h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  <p class="headline"><a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(s.title)}</a></p>
  ${body}
  ${more}
  <footer class="card-meta">${meta}</footer>
</article>`;
}

// ---------- 页面拼装 ----------
/** 每个页面在两种语言下的路径(相对站根,不带前导 /) */
const PAGE_PATH = { airdrop: '', btt: 'btt/', celeb: 'celeb/' };
const pageHref = (page, L) => `/${L.dir}${PAGE_PATH[page]}`;
const pageUrl = (page, L) => `${SITE_URL}${L.dir}${PAGE_PATH[page]}`;

function nav(active, counts, L) {
  const item = (href, key, label, n) =>
    `<a class="cat" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}<small>${n}</small></a>`;
  const other = LOCALES[L.switchLang];
  return `<div class="navwrap"><nav class="cats" aria-label="${L.navLabel}">${item(pageHref('airdrop', L), 'airdrop', L.navAirdrop, counts.airdrop)}${item(pageHref('btt', L), 'btt', L.navBtt, counts.btt)}${item(pageHref('celeb', L), 'celeb', L.navCeleb, counts.celeb)}</nav>`
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
    SITE_NAME: L.siteName,
    OG_IMAGE,
    BRAND: L.brand,
    LANG_NOTE: L[page].langNote ? `<p class="langnote">${esc(L[page].langNote)}</p>` : '',
    T_FILTER: L.filterLabel,
    T_SORT: L.sortLabel,
    T_EMPTY: L.empty,
    FRIENDS: `${esc(L.friendsLabel)} ` + FRIEND_URLS.map((href, i) => `<a href="${href}" rel="noopener">${esc(L.friends[i])}</a>`).join(' · '),
    FOOTER_SYNC: L.footerSync(`<time datetime="${new Date(generatedTs).toISOString()}">${fmtDateTime(generatedTs, L)}</time>`),
  };
}

/** JSON-LD:Organization + WebSite + WebPage + 本页列表前 20 项,一段 @graph;`<` 转义,免得条目文本里出现 </script> */
function jsonLd(page, L, { title, description, generatedTs, listName, items }) {
  const site = `${SITE_URL}${L.dir}`;
  const url = pageUrl(page, L);
  const graph = [
    { '@type': 'Organization', '@id': `${ORG_URL}#organization`, name: 'SatLoot', url: ORG_URL, sameAs: [GITHUB_URL] },
    { '@type': 'WebSite', '@id': `${site}#website`, url: site, name: L.siteName, inLanguage: L.htmlLang, publisher: { '@id': `${ORG_URL}#organization` } },
    {
      '@type': 'WebPage', '@id': url, url, name: title, description, inLanguage: L.htmlLang, isPartOf: { '@id': `${site}#website` },
      primaryImageOfPage: { '@type': 'ImageObject', url: OG_IMAGE, width: 1200, height: 630 }, dateModified: new Date(generatedTs).toISOString(),
    },
    {
      '@type': 'ItemList', name: listName, inLanguage: L.htmlLang, numberOfItems: items.length,
      itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: plain(it.name), ...(it.url ? { url: it.url } : {}) })),
    },
  ];
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}

/** static/ 里的文件(OG 分享图等)原样复制到输出目录;内容没变就不动,免得每 5 分钟改一次 mtime */
async function copyStatic() {
  let entries;
  try { entries = await fs.readdir(STATIC_DIR, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const buf = await fs.readFile(path.join(STATIC_DIR, e.name));
    const dst = path.join(OUT_DIR, e.name);
    try { if (buf.equals(await fs.readFile(dst))) continue; } catch {}
    await writeAtomic(dst, buf);
  }
}

async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

async function main() {
  await copyStatic();
  const [projects, status, reports, btt, celeb] = await Promise.all([
    getJson('/api/airdrop/projects?limit=1000', 'projects.json'),
    getJson('/api/airdrop/status', 'status.json'),
    getJson('/api/airdrop/reports?limit=10', 'reports.json'),
    loadBtt(),
    loadCeleb(),
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
  const celebRows = Array.isArray(celeb?.rows) ? celeb.rows.slice() : [];
  celebRows.sort((a, b) => (b.lastSeenTs || 0) - (a.lastSeenTs || 0) || (b.id || 0) - (a.id || 0));
  const weekMs = generatedTs - 7 * 86400_000;
  const celebToday = celebRows.filter((s) => !s.seeded && okTs(s.firstSeenTs) && s.firstSeenTs >= todayMs).length;
  const celebStrong = celebRows.filter((s) => s.level === 'strong').length;
  const celebWeek = celebRows.filter((s) => okTs(s.lastSeenTs) && s.lastSeenTs >= weekMs).length;
  const celebAnalyzed = celebRows.filter((s) => s.analysisStatus === 'done' && s.analysis).length;
  const celebTotal = celeb ? (Number.isFinite(celeb.count) ? celeb.count : celebRows.length) : 0;
  const celebLastOk = isoToMs(celeb?.lastOkAt);
  const celebMinutes = celeb?.checkEverySec ? Math.round(celeb.checkEverySec / 60) : 10;
  const celebWatch = Array.isArray(celeb?.watchlist) ? celeb.watchlist.length : 0;
  const counts = { airdrop: rows.length, btt: bttTotal, celeb: celebTotal };

  const template = await fs.readFile(path.join(__dirname, 'template.html'), 'utf8');

  // ---- 空投项目页 ----
  const airdropPage = (L) => {
    const T = L.airdrop;
    const description = T.description(rows.length, fmtDateTime(latestOkTs, L));
    return render(template, {
      ...pageCommon('airdrop', L, generatedTs),
      PAGE_TITLE: T.title,
      DESCRIPTION: description,
      JSON_LD: jsonLd('airdrop', L, { title: T.title, description, generatedTs, listName: T.heroTitle, items: rows.slice(0, 20).map((r) => ({ name: r.name })) }),
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
    const description = btt ? T.description(bttTotal, bttToday, bttAnalyzed, fmtDateTime(bttLastOk, L)) : T.descriptionOffline;
    return render(template, {
      ...pageCommon('btt', L, generatedTs),
      PAGE_TITLE: T.title,
      DESCRIPTION: description,
      JSON_LD: jsonLd('btt', L, { title: T.title, description, generatedTs, listName: T.heroTitle, items: bttRows.slice(0, 20).map((p) => ({ name: p.title, url: p.url })) }),
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

  // ---- 名人发币页 ----
  const celebPage = (L) => {
    const T = L.celeb;
    let cards;
    if (!celeb) {
      cards = `<p class="empty-initial">${T.emptyOffline}</p>`;
    } else if (!celebRows.length) {
      cards = `<p class="empty-initial">${T.emptyNoRows}</p>`;
    } else {
      cards = celebRows.map((s) => renderCelebCard(s, todayMs, weekMs, L)).join('\n');
    }
    const health = celeb && celeb.failStreak > 0 ? `<span class="warn">${T.health(celeb.failStreak, esc(celeb.lastError || ''))}</span>` : '';
    const description = celeb ? T.description(celebTotal, celebStrong, celebToday, fmtDateTime(celebLastOk, L)) : T.descriptionOffline;
    return render(template, {
      ...pageCommon('celeb', L, generatedTs),
      PAGE_TITLE: T.title,
      DESCRIPTION: description,
      JSON_LD: jsonLd('celeb', L, { title: T.title, description, generatedTs, listName: T.heroTitle, items: celebRows.slice(0, 20).map((s) => ({ name: [s.person, s.ticker ? `$${s.ticker}` : ''].filter(Boolean).join(' ') || s.title, url: s.url })) }),
      NAV: nav('celeb', counts, L),
      HERO_TITLE: T.heroTitle,
      HERO_LEDE: T.heroLede(celebMinutes, celebWatch) + health,
      STATS: [
        stat(celeb ? celebTotal : '—', T.statTotal),
        stat(celeb ? celebStrong : '—', T.statStrong),
        stat(celeb ? celebToday : '—', T.statToday),
        stat(celeb && Number.isFinite(celeb.articleCount) ? celeb.articleCount : '—', T.statArticles),
        stat(fmtDateTime(celebLastOk, L), T.statLastCheck),
      ].join(''),
      TABS: [tab('all', T.tabAll, celebRows.length, true), tab('strong', T.tabStrong, celebStrong), tab('today', T.tabToday, celebToday), tab('week', T.tabWeek, celebWeek), tab('analyzed', T.tabAnalyzed, celebAnalyzed)].join(''),
      SORT_OPTIONS: `<option value="last">${T.sortLast}</option><option value="first">${T.sortFirst}</option><option value="mentions">${T.sortMentions}</option><option value="score">${T.sortScore}</option><option value="name">${T.sortName}</option>`,
      SEARCH_PLACEHOLDER: T.searchPlaceholder,
      CARDS: cards,
      FOOTER_NOTE: T.footerNote(),
    });
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const L of [LOCALES.zh, LOCALES.en]) {
    await writeAtomic(path.join(OUT_DIR, L.dir, 'index.html'), airdropPage(L));
    await writeAtomic(path.join(OUT_DIR, L.dir, 'btt', 'index.html'), bttPage(L));
    await writeAtomic(path.join(OUT_DIR, L.dir, 'celeb', 'index.html'), celebPage(L));
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
  if (celeb) await writeAtomic(path.join(OUT_DIR, 'celeb', 'data.json'), JSON.stringify(celeb, null, 1));
  await writeAtomic(path.join(OUT_DIR, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);

  // sitemap:六个 URL,每个都带同页另一语言的 hreflang alternate(x-default 指中文)
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
    smUrl('celeb', LOCALES.zh, celebLastOk ?? generatedTs, 'hourly') +
    smUrl('celeb', LOCALES.en, celebLastOk ?? generatedTs, 'hourly') +
    `</urlset>\n`);
  console.log(`[airdrop-site] airdrop ${rows.length} (${testnetCount} testnet, ${newCount} new), btt ${btt ? `${bttTotal} posts (${bttToday} today, ${bttAnalyzed} analyzed)` : 'unavailable'}, celeb ${celeb ? `${celebTotal} events (${celebStrong} strong, ${celebToday} today)` : 'unavailable'} -> ${OUT_DIR} (zh + en)`);
}

main().catch((err) => {
  console.error('[airdrop-site] build failed:', err?.message || err);
  process.exit(1);
});
