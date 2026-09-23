#!/usr/bin/env node
// airdrop.satloot.com 静态页生成器。三个大类 × 两种语言:
//   /          空投项目(zh-CN)—— riskdesk 侧车(127.0.0.1:5177,本机直连即站主)的空投雷达存档
//   /btt/      BTT 新帖(zh-CN)—— btt/btt_monitor.py 导出的 export.json(bitcointalk 山寨板新帖 + grok 中文速览)
//   /celeb/    名人发币(zh-CN)—— celeb/celeb_monitor.py 导出的 export.json(名人/政客发币新闻事件 + grok 中文速览 + 去哪订阅)
//   /nft/      NFT 打新机会(zh-CN)—— nft/nft_monitor.py 导出的 export.json(名单项目 + AI 在 X 上发现的项目,grok 联网核查阶段/铸造时间/价格)
//   /en/  /en/btt/  /en/celeb/  /en/nft/  同一模板按 LOCALES.en 渲染;数据字段是中文来源,英文页按 条目自带 xxxEn > 译文缓存 data/i18n-en.json > 中文原文 取值
//                                          (缓存是人工翻译的,键 = plain() 规范化后的中文原文;缺译用 node tools/list-missing-en.mjs 列出来补)
// 由 systemd 定时器每 5 分钟跑一次;任一数据源挂了就保留上一版文件,不会把站点写空。
//
// 环境变量:
//   AIRDROP_API_BASE     侧车地址,默认 http://127.0.0.1:5177
//   AIRDROP_BTT_JSON     BTT 导出文件,默认 /var/lib/btt-monitor/export.json(不存在则 BTT 页显示未启动)
//   AIRDROP_CELEB_JSON   名人发币导出文件,默认 /var/lib/celeb-monitor/export.json(不存在则该页显示未启动)
//   AIRDROP_OUT_DIR      输出目录,默认 ./dist
//   AIRDROP_FIXTURE_DIR  本地测试:从该目录读 projects.json / status.json / reports.json / btt-export.json / celeb-export.json / nft-export.json,不联网
//   AIRDROP_NFT_JSON     NFT 追踪导出文件,默认 /var/lib/nft-monitor/export.json(不存在则该页显示未启动)
//   AIRDROP_I18N_EN      英文译文缓存,默认 <本目录>/data/i18n-en.json(随代码部署;读不到就全部回落中文,不影响生成)
//   AIRDROP_I18N_REPORT  可选:把英文页里仍回落中文的原文按页面写成 JSON(tools/list-missing-en.mjs 用)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.AIRDROP_API_BASE || 'http://127.0.0.1:5177').replace(/\/$/, '');
const BTT_JSON = process.env.AIRDROP_BTT_JSON || '/var/lib/btt-monitor/export.json';
const CELEB_JSON = process.env.AIRDROP_CELEB_JSON || '/var/lib/celeb-monitor/export.json';
const NFT_JSON = process.env.AIRDROP_NFT_JSON || '/var/lib/nft-monitor/export.json';
const PINNED_PATH = path.join(__dirname, 'pinned.json'); // 置顶卡(站长自营项目),随代码部署
const PARTICIPATION_PATH = path.join(__dirname, 'participation.json'); // 右侧参与表(网站管理员自用),随代码部署
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
const I18N_EN_PATH = process.env.AIRDROP_I18N_EN || path.join(__dirname, 'data', 'i18n-en.json');
const I18N_REPORT = process.env.AIRDROP_I18N_REPORT || '';

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
const loadNft = () => loadExport('nft', 'nft-export.json', NFT_JSON);

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
// NFT 核查的 stage 枚举(见 nft/nft_monitor.py STAGES)
const NFT_STAGE_EN = {
  '预热': 'Teaser', '白名单申请中': 'Whitelist open', '白名单已截止': 'Whitelist closed', '铸造中': 'Minting now',
  '已售罄': 'Sold out', '已上市': 'Trading', '延期或取消': 'Delayed / cancelled', '未知': 'Unknown',
};

const LOCALES = {
  zh: {
    code: 'zh', htmlLang: 'zh-CN', ogLocale: 'zh_CN', ogLocaleAlt: 'en_US', dir: '',
    switchLabel: 'EN', switchLang: 'en',
    brand: 'SatLoot · 空投雷达',
    siteName: 'SatLoot 空投雷达',
    navLabel: '大类', navAirdrop: '空投项目', navBtt: 'BTT 新帖', navCeleb: '名人发币', navNft: 'NFT 打新',
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
    enumStage: (v) => v,
    cal: {
      title: '铸造日历', panelTitle: '近期铸造', today: '今天', tomorrow: '明天',
      inDays: (n) => `${n} 天后`, count: (n) => `${n} 个`, tba: '待定',
      applied: '已申请', none: '暂时没有已定日期的铸造。', undated: (n) => `另有 ${n} 个项目还没公布铸造日期。`,
      more: (n) => `日历里还有 ${n} 个 →`,
    },
    side: {
      title: '参与表', note: '网站管理员自用:记录站长自己参与了哪些项目、做到哪一步。不是推荐,也不代表项目方背书。', empty: '暂无参与记录。',
      rowAction: '动作', rowStatus: '状态', rowProgress: '项目进度', rowNext: '下一步', rowDate: '日期', mint: '铸造', track: '看追踪卡片 →',
      sections: { nft: 'NFT', airdrop: '空投', btt: 'BTT', celeb: '名人币' },
    },
    pin: {
      label: '站长自营项目', badge: '站长项目',
      note: '这是本站站长自己做的项目,置顶是自荐,不是第三方收录,也不构成投资建议。',
      tzNote: '时间为北京时间(UTC+8)',
      until: (name, ms) => { const h = Math.max(1, Math.round(ms / 3600_000)); return h <= 48 ? `距${name}还有 ${h} 小时` : `距${name}还有 ${Math.round(h / 24)} 天`; },
      ongoing: (name) => `${name}进行中`,
    },
    airdrop: {
      title: '空投雷达 · SatLoot Airdrop',
      description: (n, scan) => `${n} 个正在进行的加密空投项目:链、参与方式、阶段、热度证据与风险,按项目去重并标注首次发现日期与上榜次数。最近扫描 ${scan}(北京时间)。`,
      heroTitle: '正在进行的空投项目',
      heroLede: (src) => `由 <a href="${src}" rel="noopener">earn.satloot.com</a> 的空投雷达每 6 小时自动检索一轮热门空投并存档:同一项目只出现一次,标注首次发现日期与上榜次数。字段取最近一次扫描的结论。`,
      langNote: '',
      statTotal: '项目总数', statNew: '本次新发现', statTestnet: '需测试网 BTC', statLastScan: '最近扫描(北京时间)', statNextScan: '下次扫描',
      tabAll: '全部', tabNew: '本次新发现', tabTestnet: '测试网 BTC',
      sortFirst: '最新发现', sortLast: '最近出现', sortCount: '上榜次数', sortName: '名称',
      searchPlaceholder: '搜索项目、链、参与方式…',
      emptyInitial: '雷达还没有产出任何项目,稍后再来。',
      footerNote: (src) => `数据来源:<a href="${src}" rel="noopener">earn.satloot.com 空投雷达</a>(AI 每 6 小时检索网页与社媒后整理)。机器可读:<a href="/data.json">data.json</a>。`,
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
    nft: {
      title: 'NFT 打新机会 · SatLoot Airdrop',
      description: (total, wl, soon, check) => `NFT 白名单与铸造机会追踪:${total} 个项目,${wl} 个白名单开放中,${soon} 个 7 天内铸造。AI 定时用 X 搜索核查阶段、铸造时间、价格与总量,有变动即推送,铸造前 24 小时与 1 小时提醒。最近核查 ${check}(北京时间)。`,
      descriptionOffline: 'NFT 白名单与铸造机会追踪:AI 定时用 X 搜索核查阶段、铸造时间、价格与总量,有变动即推送,并在 X 上发现新的打新机会。',
      heroTitle: 'NFT 打新机会',
      heroLede: (t, dh) => `重点是把机会先找出来,核查按状态分档、不反复折腾:已申请的项目在铸造前后每 ${t.nearApplied} 小时核查一次,名单项目 ${t.near} 小时,已定铸造日期每 ${t.dated} 小时,白名单开放中每 ${t.wl} 小时,暂无日程每 ${t.quiet} 小时(AI 发现的项目频率减半)。阶段、铸造时间、铸造价、总量、单钱包上限一变就推送,铸造前 24 小时和 1 小时各提醒一次。${dh ? `另外每 ${dh} 小时让 AI 在 X 上找一批新的白名单 / mint 机会,标为「AI 发现」,不限数量。` : ''}KOL 观点原样标注出处,不构成推荐。<span class="warn">AI 检索可能看错,铸造前务必到项目官方 X 核对合约与铸造链接,不点私信和评论区里的链接。</span>`,
      health: (n, err) => `核查连续失败 ${n} 次,最新错误:${err}`,
      langNote: '',
      statTotal: '追踪项目', statWl: '白名单开放中', statSoon: '7 天内铸造', statChanged: '24 小时内有变动', statLastCheck: '最近核查(北京时间)',
      tabAll: '全部', tabToday: '今日铸造', tabCurated: '名单项目', tabWl: '白名单开放', tabSoon: '即将铸造', tabChanged: '最近变动', tabDiscovered: 'AI 发现',
      sortSoon: '铸造时间', sortChanged: '最近变动', sortScore: '评分', sortFirst: '最新收录', sortName: '名称',
      searchPlaceholder: '搜索项目、链、GTD、抽奖、Arc…',
      emptyOffline: 'NFT 追踪尚未启动或还没有导出数据,稍后再来。',
      emptyNoRows: '追踪已启动,名单还是空的。',
      footerNote: () => `数据来源:项目官方 X、官网与 KOL 推文,由 AI(grok)联网检索整理;名单项目的初始资料与 KOL 观点为人工录入。机器可读:<a href="/nft/data.json">nft/data.json</a>。`,
      badgeDiscovered: 'AI 发现', badgeChanged: '24h 内有变动', badgeScore: (s) => `评分 ${s}/10`, badgeWait: '首次核查中', badgeFailed: '核查失败', badgeStale: '最近一次核查失败',
      countdown: (ms) => { const h = ms / 3600_000; return h < 48 ? `${Math.max(1, Math.round(h))} 小时后铸造` : `${Math.round(h / 24)} 天后铸造`; },
      rowChain: '链', rowCreator: '创作者', rowSupply: '总量', rowPrice: '铸造价', rowPerWallet: '单钱包', rowMechanism: '机制', rowMintTime: '铸造时间',
      rowWl: '拿白名单', rowWlDeadline: '白名单截止', rowLatest: '最新动态', rowWhy: '发现理由', rowNext: '现在该做', rowRisk: '风险', rowVerdict: '结论', rowExtra: '备注',
      notesLabel: 'KOL 观点', rowContract: '合约', linksLabel: '关键链接',
      linkLabels: { x: 'X', site: '官网', mint: '铸造页', wl_apply: '白名单申请', wl_checker: '名单查询', discord: 'Discord', telegram: 'Telegram', docs: '文档 / 白皮书', market: '二级市场', explorer: '合约浏览器', source: '发现来源推文', kol: 'KOL 推文' },
      pendingWait: 'AI 正在用 X 搜索核查这个项目,几分钟后刷新。', pendingFailed: 'AI 核查多次失败,先看项目官方 X。',
      fields: { stage: '阶段', mint_time_utc: '铸造时间', mint_price: '铸造价', supply: '总量', per_wallet: '单钱包' },
      moreChanges: (n) => `变动记录 ${n} 条`, moreSources: (n) => `参考来源 ${n} 个`,
      metaFirst: '收录', metaChecked: '核查', metaNext: '下次', metaSite: '官网',
    },
  },
  en: {
    code: 'en', htmlLang: 'en', ogLocale: 'en_US', ogLocaleAlt: 'zh_CN', dir: 'en/',
    switchLabel: '中文', switchLang: 'zh',
    brand: 'SatLoot · Airdrop Radar',
    siteName: 'SatLoot Airdrop Radar',
    navLabel: 'Sections', navAirdrop: 'Airdrops', navBtt: 'BTT threads', navCeleb: 'Celebrity coins', navNft: 'NFT mints',
    filterLabel: 'Filter', sortLabel: 'Sort', empty: 'Nothing matches',
    tz: 'UTC+8',
    date: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year}`,
    dateTime: (o) => `${MON_EN[Number(o.month) - 1]} ${Number(o.day)}, ${o.year} ${o.hour}:${o.minute}`,
    friendsLabel: 'Links:',
    friends: ['satloot project index', 'Futures simulator', 'BNBBANG mirror universe', 'BTCBANG Bitcoin universe', 'riskdesk risk panel', 'satloot arcade', 'satloot tools', 'TRX staking yield calculator', 'Bitcoin testnet faucet'],
    footerSync: (time) => `This page syncs every 5 minutes; this copy was generated ${time} (UTC+8). Information only, not investment advice. Airdrops and new coins attract phishing sites and fake wallets: verify official channels before interacting, and never enter a seed phrase or private key on any page.`,
    enumKind: (v) => BTT_KIND_EN[v] ?? tx(v, LOCALES.en),
    enumMining: (v) => BTT_MINING_EN[v] ?? tx(v, LOCALES.en),
    enumStatus: (v) => CELEB_STATUS_EN[v] ?? tx(v, LOCALES.en),
    enumStage: (v) => NFT_STAGE_EN[v] ?? tx(v, LOCALES.en),
    cal: {
      title: 'Mint calendar', panelTitle: 'Upcoming mints', today: 'today', tomorrow: 'tomorrow',
      inDays: (n) => `in ${n} days`, count: (n) => `${n}`, tba: 'TBA',
      applied: 'Applied', none: 'No mints with a confirmed date yet.', undated: (n) => `${n} more projects have no mint date yet.`,
      more: (n) => `${n} more in the calendar →`,
    },
    side: {
      title: 'Participation log', note: "For the site admin's own use: which projects the admin has joined and how far along. Not a recommendation or an endorsement.", empty: 'No entries yet.',
      rowAction: 'Action', rowStatus: 'Status', rowProgress: 'Project', rowNext: 'Next', rowDate: 'Date', mint: 'Mint', track: 'Open tracker card →',
      sections: { nft: 'NFT', airdrop: 'Airdrop', btt: 'BTT', celeb: 'Celeb coin' },
    },
    pin: {
      label: 'Our own project', badge: 'Our project',
      note: 'This project is built by the site admin: it is pinned here as our own promotion, not a third-party listing, and it is not investment advice.',
      tzNote: 'All times UTC+8',
      until: (name, ms) => { const h = Math.max(1, Math.round(ms / 3600_000)); return h <= 48 ? `${name} in ${h}h` : `${name} in ${Math.round(h / 24)} days`; },
      ongoing: (name) => `${name} is live`,
    },
    airdrop: {
      title: 'Airdrop Radar · SatLoot Airdrop',
      description: (n, scan) => `${n} ongoing crypto airdrops: chain, how to join, stage, buzz and risks, deduplicated by project with first-seen dates. Last scan ${scan} (UTC+8).`,
      heroTitle: 'Ongoing airdrop projects',
      heroLede: (src) => `The airdrop radar at <a href="${src}" rel="noopener">earn.satloot.com</a> searches for trending airdrops every 6 hours and archives them: each project appears once, tagged with its first-seen date and how many times it has been listed. Fields reflect the latest scan.`,
      langNote: 'Some project details have no English translation yet and are shown in the original Chinese.',
      statTotal: 'Projects', statNew: 'New this scan', statTestnet: 'Need testnet BTC', statLastScan: 'Last scan (UTC+8)', statNextScan: 'Next scan',
      tabAll: 'All', tabNew: 'New this scan', tabTestnet: 'Testnet BTC',
      sortFirst: 'Newest found', sortLast: 'Last seen', sortCount: 'Times listed', sortName: 'Name',
      searchPlaceholder: 'Search project, chain, how to join…',
      emptyInitial: 'The radar has not produced any projects yet. Check back later.',
      footerNote: (src) => `Source: <a href="${src}" rel="noopener">earn.satloot.com airdrop radar</a> (an AI searches the web and social media every 6 hours and compiles the results). Machine-readable: <a href="/data.json">data.json</a>.`,
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
      langNote: 'Some AI digests have no English translation yet and are shown in the original Chinese.',
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
      langNote: 'Some AI digests have no English translation yet and are shown in the original Chinese.',
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
    nft: {
      title: 'NFT Mint Tracker · SatLoot Airdrop',
      description: (total, wl, soon, check) => `NFT whitelist and mint tracker: ${total} projects, ${wl} with an open whitelist, ${soon} minting within 7 days. An AI re-checks stage, mint time, price and supply on X; changes are pushed, with reminders 24 hours and 1 hour before mint. Last check ${check} (UTC+8).`,
      descriptionOffline: 'NFT whitelist and mint tracker: an AI re-checks stage, mint time, price and supply on X, pushes changes, and finds new mint opportunities.',
      heroTitle: 'NFT mint tracker',
      heroLede: (t, dh) => `Finding opportunities comes first; re-checks are paced by state rather than repeated constantly: projects the admin has applied to are re-checked every ${t.nearApplied} hours around mint time, watchlist projects every ${t.near} hours, every ${t.dated} hours once a mint date is set, every ${t.wl} hours while the whitelist is open, and every ${t.quiet} hours when nothing is scheduled (AI-found projects at half that rate). Any change to stage, mint time, mint price, supply or per-wallet cap is pushed, and reminders go out 24 hours and 1 hour before mint.${dh ? ` Every ${dh} hours the AI also searches X for new whitelist / mint opportunities, tagged "AI found", with no cap on how many.` : ''} KOL opinions are quoted with attribution and are not recommendations. <span class="warn">AI search can misread posts: verify the contract and mint link on the project's official X before minting, and never click links from DMs or replies.</span>`,
      health: (n, err) => `The check has failed ${n} times in a row; latest error: ${err}`,
      langNote: 'Some project details, AI checks and KOL notes have no English translation yet and are shown in the original Chinese.',
      statTotal: 'Projects', statWl: 'Whitelist open', statSoon: 'Minting in 7 days', statChanged: 'Changed in 24h', statLastCheck: 'Last check (UTC+8)',
      tabAll: 'All', tabToday: 'Minting today', tabCurated: 'Watchlist', tabWl: 'Whitelist open', tabSoon: 'Minting soon', tabChanged: 'Recently changed', tabDiscovered: 'AI found',
      sortSoon: 'Mint time', sortChanged: 'Latest change', sortScore: 'Score', sortFirst: 'Newest added', sortName: 'Name',
      searchPlaceholder: 'Search project, chain, GTD, raffle, Arc…',
      emptyOffline: 'The NFT tracker has not started or has not exported data yet. Check back later.',
      emptyNoRows: 'The tracker is running but the watchlist is empty.',
      footerNote: () => `Sources: official project X accounts, websites and KOL posts, compiled by an AI (grok) with web search; watchlist details and KOL notes are entered by hand. Machine-readable: <a href="/nft/data.json">nft/data.json</a>.`,
      badgeDiscovered: 'AI found', badgeChanged: 'Changed in 24h', badgeScore: (s) => `Score ${s}/10`, badgeWait: 'First check running', badgeFailed: 'Check failed', badgeStale: 'Last check failed',
      countdown: (ms) => { const h = ms / 3600_000; return h < 48 ? `Mints in ${Math.max(1, Math.round(h))}h` : `Mints in ${Math.round(h / 24)}d`; },
      rowChain: 'Chain', rowCreator: 'Creator', rowSupply: 'Supply', rowPrice: 'Mint price', rowPerWallet: 'Per wallet', rowMechanism: 'Mechanism', rowMintTime: 'Mint time',
      rowWl: 'Whitelist', rowWlDeadline: 'WL deadline', rowLatest: 'Latest', rowWhy: 'Why listed', rowNext: 'Do now', rowRisk: 'Risk', rowVerdict: 'Verdict', rowExtra: 'Note',
      notesLabel: 'KOL notes', rowContract: 'Contract', linksLabel: 'Key links',
      linkLabels: { x: 'X', site: 'Website', mint: 'Mint page', wl_apply: 'Whitelist form', wl_checker: 'WL checker', discord: 'Discord', telegram: 'Telegram', docs: 'Docs', market: 'Marketplace', explorer: 'Explorer', source: 'Source post', kol: 'KOL post' },
      pendingWait: 'The AI is checking this project on X; refresh in a few minutes.', pendingFailed: 'The AI check failed repeatedly; see the official X account.',
      fields: { stage: 'Stage', mint_time_utc: 'Mint time', mint_price: 'Mint price', supply: 'Supply', per_wallet: 'Per wallet' },
      moreChanges: (n) => `${n} changes`, moreSources: (n) => `${n} sources`,
      metaFirst: 'Added', metaChecked: 'Checked', metaNext: 'Next', metaSite: 'Website',
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

// ---------- 英文译文缓存(data/i18n-en.json) ----------
// 监控/雷达产出的字段都是中文。英文页取值顺序:条目自带的 xxxEn 字段 > 人工译文缓存 > 中文原文。
// 缓存键 = plain() 规范化后的中文原文(去 markdown、压空白),同一句话出现在多个条目/多个页面只译一次;
// 数据更新后原文变了就自然变成缺译,回落中文,不会张冠李戴。缺译按页面记下来,供 tools/list-missing-en.mjs 汇总。
const CJK_RE = /[㐀-鿿豈-﫿]/;
const I18N = { map: new Map(), page: null, miss: {}, hits: {} };
async function loadI18n() {
  try {
    const d = JSON.parse(await fs.readFile(I18N_EN_PATH, 'utf8'));
    const entries = d && typeof d.entries === 'object' ? d.entries : {};
    for (const [zh, en] of Object.entries(entries)) {
      const k = plain(zh);
      if (k && typeof en === 'string' && en.trim()) I18N.map.set(k, en.trim());
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[airdrop-site] ${I18N_EN_PATH} unreadable: ${err?.message || err}`);
  }
}
/** 数据字段在英文页的显示值:缓存命中给英文,否则原样(并记一笔缺译)。中文页、空值、本来就不含中文的原样返回 */
function tx(s, L) {
  if (L.code !== 'en' || !has(s)) return s;
  const key = plain(s);
  if (!CJK_RE.test(key)) return s;
  const pg = I18N.page || 'other';
  const hit = I18N.map.get(key);
  if (hit) {
    I18N.hits[pg] = (I18N.hits[pg] || 0) + 1;
    return hit;
  }
  (I18N.miss[pg] ||= new Set()).add(key);
  return s;
}
/** 条目自带英文(o[k + 'En'])优先,其次缓存,最后中文 */
const txf = (o, k, L) => (L.code === 'en' && has(o?.[`${k}En`]) ? o[`${k}En`] : tx(o?.[k], L));
/** data-search:英文页用译文(缺译的用原文) */
const searchBlob = (list, L) => list.map((x) => plain(tx(x, L))).join(' ').toLowerCase();

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
  const f = (k) => txf(r, k, L);
  const dl = dlRows([
    [T.rowChain, f('chain')],
    [T.rowParticipation, f('participation')],
    [T.rowTestnet, testnet ? f('testnetDetail') : null],
    [T.rowDeadline, f('deadline')],
    [T.rowBuzz, f('buzz')],
    [T.rowRisk, f('risk'), 'row-risk'],
  ]);
  const search = searchBlob([f('name'), f('chain'), f('participation'), f('deadline'), f('buzz'), f('risk'), f('testnetDetail')], L);
  return `<article class="card" data-testnet="${testnet ? 1 : 0}" data-new="${isNew ? 1 : 0}" data-first="${r.firstSeenTs}" data-last="${r.lastSeenTs}" data-count="${r.seenCount}" data-search="${esc(search)}">
  <header class="card-head">
    <h2>${esc(f('name'))}</h2>
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
  const af = (k) => txf(a, k, L);
  const body = a
    ? `<dl>${dlRows([
        [T.rowName, af('name')],
        [T.rowChain, af('chain')],
        [T.rowToken, af('token')],
        [T.rowDistribution, af('distribution')],
        [T.rowMining, /不可挖|非矿币/.test(mining) ? null : L.enumMining(mining)],
        [T.rowHighlights, af('highlights')],
        [T.rowRedFlags, af('red_flags'), 'row-risk'],
        [T.rowVerdict, af('verdict'), 'row-verdict'],
      ])}</dl>`
    : `<p class="pending">${p.analysisStatus === 'failed' ? T.pendingFailed : p.analysisStatus === 'skipped' ? T.pendingSkipped : T.pendingWait}</p>`;
  const meta = [
    `<span>${T.metaFound} <time datetime="${okTs(p.firstSeenTs) ? new Date(p.firstSeenTs).toISOString() : ''}">${fmtDateTime(p.firstSeenTs, L)}</time></span>`,
    p.author ? `<span>${T.metaAuthor} ${esc(p.author)}</span>` : '',
    p.postedAt ? `<span>${T.metaPosted} ${esc(p.postedAt)}</span>` : '',
    `<a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${T.metaPost(esc(p.topicId))}</a>`,
  ].filter(Boolean).join('');
  const search = searchBlob([p.title, p.author, a?.name, a && L.enumKind(plain(a.kind)), a?.chain, a?.token, a?.distribution, a?.highlights, a?.red_flags, a?.verdict], L);
  return `<article class="card" data-today="${isToday ? 1 : 0}" data-analyzed="${a ? 1 : 0}" data-pow="${pow ? 1 : 0}" data-cpu="${cpu ? 1 : 0}" data-first="${okTs(p.firstSeenTs) ? p.firstSeenTs : 0}" data-score="${score ?? -1}" data-search="${esc(search)}">
  <header class="card-head">
    <h2><a href="${esc(p.url)}" target="_blank" rel="noopener nofollow">${esc(txf(p, 'title', L))}</a></h2>
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
  const person = plain(txf(a, 'person', L)) || tx(s.person, L) || '';
  const ticker = s.ticker ? `$${s.ticker}` : '';
  const heading = [person, ticker].filter(Boolean).join(' · ') || txf(s, 'title', L);
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
  const af = (k) => txf(a, k, L);
  const body = a
    ? `<dl>${dlRows([
        [T.rowRole, af('role')],
        [T.rowToken, af('token')],
        [T.rowChain, af('chain')],
        [T.rowDate, af('launch_date')],
        [T.rowAirdrop, af('airdrop')],
        [T.rowSubscribe, af('subscribe'), 'row-verdict'],
        [T.rowCredibility, af('credibility')],
        [T.rowVerdict, af('verdict'), 'row-verdict'],
      ])}</dl>`
    : `<dl>${dlRows([[T.rowSubscribeHint, txf(s, 'subscribe', L), 'row-verdict']])}</dl><p class="pending">${s.analysisStatus === 'failed' ? T.pendingFailed : s.analysisStatus === 'skipped' ? T.pendingSkipped : T.pendingWait}</p>`;
  const arts = Array.isArray(s.articles) ? s.articles : [];
  const others = arts.filter((x) => x.url !== s.url).slice(0, 5);
  const more = others.length
    ? `<details class="more"><summary>${T.moreArticles(Math.max(s.mentions - 1, others.length))}</summary><ul>${others.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener nofollow">${esc(txf(x, 'title', L))}</a> <small>${esc(x.source || '')}</small></li>`).join('')}</ul></details>`
    : '';
  const meta = [
    `<span>${T.metaFirst} <time datetime="${okTs(s.firstSeenTs) ? new Date(s.firstSeenTs).toISOString() : ''}">${fmtDateTime(s.firstSeenTs, L)}</time></span>`,
    `<span>${T.metaLast} <time datetime="${okTs(s.lastSeenTs) ? new Date(s.lastSeenTs).toISOString() : ''}">${fmtDateTime(s.lastSeenTs, L)}</time></span>`,
    s.source ? `<span>${T.metaSource} ${esc(s.source)}</span>` : '',
  ].filter(Boolean).join('');
  const search = searchBlob([s.person, s.ticker, s.title, s.source, s.subscribe, a?.person, a?.role, a?.token, a?.chain, a?.airdrop, a?.subscribe, a?.verdict, ...arts.map((x) => x.title)], L);
  return `<article class="card" data-strong="${strong ? 1 : 0}" data-today="${isToday ? 1 : 0}" data-week="${inWeek ? 1 : 0}" data-analyzed="${a ? 1 : 0}" data-first="${okTs(s.firstSeenTs) ? s.firstSeenTs : 0}" data-last="${okTs(s.lastSeenTs) ? s.lastSeenTs : 0}" data-mentions="${s.mentions || 0}" data-score="${score ?? -1}" data-search="${esc(search)}">
  <header class="card-head">
    <h2>${esc(heading)}</h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  <p class="headline"><a href="${esc(s.url)}" target="_blank" rel="noopener nofollow">${esc(txf(s, 'title', L))}</a></p>
  ${body}
  ${more}
  <footer class="card-meta">${meta}</footer>
</article>`;
}

// ---------- NFT 打新机会卡片 ----------
const NFT_OPEN_STAGES = new Set(['白名单申请中', '铸造中']);
// 关键链接按钮的顺序(键与 nft/nft_monitor.py LINK_KEYS 一致)
const NFT_LINK_KEYS = ['mint', 'site', 'wl_apply', 'wl_checker', 'discord', 'telegram', 'docs', 'market', 'explorer'];
const NFT_DONE_STAGES = new Set(['已售罄', '已上市', '延期或取消']);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const xUrl = (handle) => `https://x.com/${encodeURIComponent(handle)}`;
const MINT_DATE_RE = /(20\d{2})-(\d{1,2})-(\d{1,2})/;
/** 铸造日(北京时间 YYYY-MM-DD):优先用换算好的时间戳,其次从铸造时间原文里抠日期 */
function mintDayKey(p) {
  if (okTs(p.mintTs)) return fmtIsoDate(p.mintTs);
  const m = MINT_DATE_RE.exec(plain(p.snapshot?.mint_time) || '');
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
}
/** 展示值:最近一次核查 > 名单人工资料 > AI 发现线索 */
function nftView(p, nowMs) {
  const s = p.snapshot || null;
  const c = p.curated || {};
  const d = p.discovered || {};
  const pick = (k) => [s?.[k], c[k], d[k]].find(has) ?? '';
  const stage = s?.stage && s.stage !== '未知' ? s.stage : '';
  const mintTs = okTs(p.mintTs) ? p.mintTs : null;
  const future = mintTs != null && mintTs > nowMs;
  const minting = stage === '铸造中';
  const soon = minting || (future && mintTs - nowMs <= 7 * 86400_000 && !NFT_DONE_STAGES.has(stage));
  const changed = okTs(p.lastChangeTs) && nowMs - p.lastChangeTs <= 86400_000;
  const score = s && Number.isFinite(s.score) ? s.score : null;
  // 排序键:正在铸造最前,其次铸造时间越近越前,没公布时间的排后
  const soonKey = minting ? 1e13 : future ? 1e13 - mintTs : 0;
  const name = plain(s?.name) || c.name || d.name || p.name || `@${p.handle}`;
  return { s, c, d, pick, stage, mintTs, future, soon, changed, score, soonKey, name, curated: p.origin !== 'discovered' };
}
function renderNftCard(p, nowMs, L) {
  const T = L.nft;
  const v = nftView(p, nowMs);
  const { s, c, d } = v;
  const pick = (k) => tx(v.pick(k), L);
  const t = (x) => tx(x, L);
  const name = t(v.name);
  const badges = [];
  if (!v.curated) badges.push(`<span class="badge badge-dim">${T.badgeDiscovered}</span>`);
  else for (const tag of (Array.isArray(c.tags) ? c.tags : []).slice(0, 2)) badges.push(`<span class="badge badge-testnet">${esc(t(tag))}</span>`);
  if (v.stage) badges.push(`<span class="badge ${NFT_OPEN_STAGES.has(v.stage) ? 'badge-new' : NFT_DONE_STAGES.has(v.stage) ? 'badge-dim' : 'badge-mid'}">${esc(L.enumStage(v.stage))}</span>`);
  if (v.future && !NFT_DONE_STAGES.has(v.stage)) badges.push(`<span class="badge badge-new">${T.countdown(v.mintTs - nowMs)}</span>`);
  if (v.changed) badges.push(`<span class="badge badge-low">${T.badgeChanged}</span>`);
  if (v.score != null) badges.push(`<span class="badge ${scoreClass(v.score)}">${T.badgeScore(v.score)}</span>`);
  if (!s) badges.push(p.trackStatus === 'failed' ? `<span class="badge badge-low">${T.badgeFailed}</span>` : `<span class="badge badge-dim badge-wait">${T.badgeWait}</span>`);
  else if (p.trackStatus === 'failed') badges.push(`<span class="badge badge-low">${T.badgeStale}</span>`);
  const mintTime = has(s?.mint_time) ? t(s.mint_time) : v.mintTs ? `${fmtDateTime(v.mintTs, L)} (${L.tz})` : '';
  const dl = dlRows([
    [T.rowChain, pick('chain')],
    [T.rowCreator, txf(c, 'creator', L)],
    [T.rowSupply, pick('supply')],
    [T.rowPrice, pick('mint_price')],
    [T.rowPerWallet, pick('per_wallet')],
    [T.rowMechanism, pick('mechanism')],
    [T.rowContract, pick('contract')],
    [T.rowMintTime, mintTime],
    [T.rowWl, pick('wl_how'), 'row-verdict'],
    [T.rowWlDeadline, t(s?.wl_deadline)],
    [T.rowLatest, t(s?.latest)],
    [T.rowWhy, v.curated ? '' : txf(d, 'why', L)],
    [T.rowExtra, txf(c, 'extra', L)],
    [T.rowNext, t(s?.next_action), 'row-verdict'],
    [T.rowRisk, t(s?.risk), 'row-risk'],
    [T.rowVerdict, t(s?.verdict)],
  ]);
  const pending = s ? '' : `<p class="pending">${p.trackStatus === 'failed' ? T.pendingFailed : T.pendingWait}</p>`;
  const notes = (Array.isArray(p.notes) ? p.notes : []).filter((n) => has(n?.text));
  const notesHtml = notes.length
    ? `<div class="notes"><div class="notes-label">${T.notesLabel}</div>${notes.map((n) => {
        const by = esc(tx(n.by, L) || '');
        const who = safeUrl(n.url) ? `<a href="${esc(n.url)}" target="_blank" rel="noopener nofollow">${by}</a>` : by;
        return `<blockquote>${esc(plain(txf(n, 'text', L)))}<cite>${who}${n.date ? ` · ${esc(n.date)}` : ''}</cite></blockquote>`;
      }).join('')}</div>`
    : '';
  // 关键链接:X 在最前,其后 铸造页 / 官网 / 白名单…(核查结果优先,名单人工资料兜底),再挂 AI 发现来源与 KOL 推文;同一网址只出现一次
  const linkMap = { ...(c.links || {}), ...(s?.links || {}) };
  if (!linkMap.site && c.site) linkMap.site = c.site;
  const seenUrls = new Set();
  const chips = [['x', xUrl(p.handle)], ...NFT_LINK_KEYS.map((k) => [k, linkMap[k]]), ['source', d.source_url], ...notes.map((n) => ['kol', n.url])]
    .map(([k, u]) => [k, safeUrl(u)])
    .filter(([, u]) => {
      const key = u.replace(/\/+$/, '').toLowerCase();
      if (!u || seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    })
    .map(([k, u]) => `<a class="link-chip${k === 'mint' ? ' link-mint' : ''}" href="${esc(u)}" target="_blank" rel="noopener nofollow" title="${esc(u)}">${esc(T.linkLabels[k] || k)}</a>`);
  const linksHtml = `<nav class="links" aria-label="${T.linksLabel}">${chips.join('')}</nav>`;
  const changes = Array.isArray(p.changes) ? p.changes : [];
  const fieldVal = (f, x) => esc((f === 'stage' ? L.enumStage(plain(x)) : plain(t(x))) || '—');
  const history = changes.length
    ? `<details class="more"><summary>${T.moreChanges(changes.length)}</summary><ul>${changes.map((x) => `<li><small>${fmtDateTime(x.ts, L)}</small> ${esc(T.fields[x.field] || x.field)}: ${fieldVal(x.field, x.old)} → ${fieldVal(x.field, x.new)}</li>`).join('')}</ul></details>`
    : '';
  const sources = [...new Set([...(Array.isArray(s?.sources) ? s.sources : []), d.source_url].map(safeUrl).filter(Boolean))];
  const srcs = sources.length
    ? `<details class="more"><summary>${T.moreSources(sources.length)}</summary><ul>${sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90))}</a></li>`).join('')}</ul></details>`
    : '';
  const site = safeUrl(c.site);
  const meta = [
    `<span>${T.metaFirst} <time datetime="${okTs(p.firstSeenTs) ? new Date(p.firstSeenTs).toISOString() : ''}">${fmtDate(p.firstSeenTs, L)}</time></span>`,
    okTs(p.lastTrackTs) ? `<span>${T.metaChecked} <time datetime="${new Date(p.lastTrackTs).toISOString()}">${fmtDateTime(p.lastTrackTs, L)}</time></span>` : '',
    okTs(p.nextTrackTs) && p.nextTrackTs > nowMs ? `<span>${T.metaNext} ${fmtDateTime(p.nextTrackTs, L)}</span>` : '',
    `<a href="${xUrl(p.handle)}" target="_blank" rel="noopener nofollow">@${esc(p.handle)}</a>`,
    site ? `<a href="${esc(site)}" target="_blank" rel="noopener nofollow">${T.metaSite}</a>` : '',
  ].filter(Boolean).join('');
  const search = searchBlob([v.name, p.handle, ...(Array.isArray(c.tags) ? c.tags : []), c.creator, v.pick('chain'), v.pick('supply'), v.pick('mint_price'), v.pick('mechanism'), v.pick('wl_how'), s?.latest, s?.verdict, d.why, ...notes.map((n) => `${n.by} ${plain(txf(n, 'text', L))}`)], L);
  const mintsToday = mintDayKey(p) === fmtIsoDate(nowMs) && !NFT_DONE_STAGES.has(v.stage);
  return `<article class="card" id="nft-${esc(String(p.handle).toLowerCase())}" data-todaymint="${mintsToday ? 1 : 0}" data-curated="${v.curated ? 1 : 0}" data-discovered="${v.curated ? 0 : 1}" data-wl="${v.stage === '白名单申请中' ? 1 : 0}" data-soon="${v.soon ? 1 : 0}" data-changed="${v.changed ? 1 : 0}" data-mint="${v.soonKey}" data-change="${okTs(p.lastChangeTs) ? p.lastChangeTs : 0}" data-score="${v.score ?? -1}" data-first="${okTs(p.firstSeenTs) ? p.firstSeenTs : 0}" data-search="${esc(search)}">
  <header class="card-head">
    <h2><a href="${xUrl(p.handle)}" target="_blank" rel="noopener nofollow">${esc(name)}</a></h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  ${linksHtml}
  <dl>${dl}</dl>
  ${pending}
  ${notesHtml}
  ${history}
  ${srcs}
  <footer class="card-meta">${meta}</footer>
</article>`;
}

// ---------- 铸造日历 ----------
/** 已定日期的项目按铸造日分组,只看今天及以后;compact=右侧栏窄版 */
function calendarDays(nftRows, nowMs) {
  const today = fmtIsoDate(nowMs);
  const byDay = new Map();
  let undated = 0;
  for (const p of nftRows) {
    const v = nftView(p, nowMs);
    if (NFT_DONE_STAGES.has(v.stage)) continue;
    const day = mintDayKey(p);
    if (!day) { undated++; continue; }
    if (day < today) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ p, v });
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.p.mintTs || 0) - (b.p.mintTs || 0));
  return { days: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])), undated, today };
}
function dayLabel(day, today, nowMs, L) {
  const T = L.cal;
  const dayMs = Date.parse(`${day}T00:00:00+08:00`);
  const diff = Math.round((dayMs - Date.parse(`${today}T00:00:00+08:00`)) / 86400_000);
  const date = fmtDate(dayMs + 12 * 3600_000, L);
  if (diff === 0) return `${date} · ${T.today}`;
  if (diff === 1) return `${date} · ${T.tomorrow}`;
  return `${date} · ${T.inDays(diff)}`;
}
function calItem({ p, v }, L, applied) {
  const T = L.cal;
  const time = okTs(p.mintTs) ? fmtDateTime(p.mintTs, L).slice(-5) : T.tba;
  const tags = [
    applied.has(String(p.handle).toLowerCase()) ? `<span class="badge badge-new">${T.applied}</span>` : '',
    v.stage === '铸造中' ? `<span class="badge badge-testnet">${esc(L.enumStage(v.stage))}</span>` : '',
    v.curated ? '' : `<span class="badge badge-dim">${L.nft.badgeDiscovered}</span>`,
  ].filter(Boolean).join('');
  const price = has(v.pick('mint_price')) ? `<small>${esc(plain(tx(v.pick('mint_price'), L)).slice(0, 28))}</small>` : '';
  return `<li class="cal-item"><b class="cal-time">${esc(time)}</b><a href="${pageHref('nft', L)}#nft-${esc(String(p.handle).toLowerCase())}">${esc(tx(v.name, L))}</a>${tags}${price}</li>`;
}
/** NFT 页顶部的完整日历 */
function renderCalendar(nftRows, nowMs, L, applied) {
  const T = L.cal;
  const { days, undated, today } = calendarDays(nftRows, nowMs);
  if (!days.length) return `<section class="cal"><h2 class="cal-title">${T.title}</h2><p class="panel-note">${T.none}${undated ? ` ${T.undated(undated)}` : ''}</p></section>`;
  const blocks = days.slice(0, 14).map(([day, list]) =>
    `<div class="cal-day"><h3>${esc(dayLabel(day, today, nowMs, L))}<small>${T.count(list.length)}</small></h3><ul>${list.map((x) => calItem(x, L, applied)).join('')}</ul></div>`).join('');
  return `<section class="cal"><h2 class="cal-title">${T.title}</h2><div class="cal-grid">${blocks}</div>${undated ? `<p class="panel-note">${T.undated(undated)}</p>` : ''}</section>`;
}
/** 右侧栏的窄版:最近 6 条 */
function renderCalendarPanel(nftRows, nowMs, L, applied) {
  const T = L.cal;
  const { days, today } = calendarDays(nftRows, nowMs);
  const flat = [];
  for (const [day, list] of days) for (const x of list) flat.push([day, x]);
  if (!flat.length) return '';
  const shown = flat.slice(0, 6);
  return `<section class="panel"><h2 class="panel-title">${T.panelTitle}</h2><ul class="plist cal-panel">`
    + shown.map(([day, x]) => `<li><div class="cal-panel-day">${esc(dayLabel(day, today, nowMs, L))}</div>${calItem(x, L, applied)}</li>`).join('')
    + `</ul>${flat.length > shown.length ? `<p class="panel-note"><a href="${pageHref('nft', L)}">${T.more(flat.length - shown.length)}</a></p>` : ''}</section>`;
}

// ---------- 右侧参与表(网站管理员自用) ----------
async function loadParticipation() {
  try {
    const d = JSON.parse(await fs.readFile(PARTICIPATION_PATH, 'utf8'));
    return Array.isArray(d.items) ? d.items : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[airdrop-site] participation.json unreadable: ${err?.message || err}`);
    return [];
  }
}
/** NFT 项目带 handle 的,顺带显示追踪到的实时进度(阶段、铸造时间、倒计时)并链到卡片 */
function renderSidebar(items, nftByHandle, nowMs, L) {
  const T = L.side;
  const tr = (it, k) => txf(it, k, L);
  const lis = items.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).map((it) => {
    const handle = String(it.handle || '').replace(/^@/, '');
    const row = handle ? nftByHandle.get(handle.toLowerCase()) : null;
    let progress = '';
    if (row) {
      const v = nftView(row, nowMs);
      const bits = [];
      if (v.stage) bits.push(L.enumStage(v.stage));
      // 侧栏窄:有钟点就用钟点;只有文字描述时截到 32 字,完整内容在追踪卡片里
      const rawMt = v.mintTs ? `${fmtDateTime(v.mintTs, L)} (${L.tz})` : has(v.s?.mint_time) ? plain(tx(v.s.mint_time, L)) : '';
      const mt = [...rawMt].length > 32 ? `${[...rawMt].slice(0, 32).join('')}…` : rawMt;
      if (mt) bits.push(`${T.mint} ${mt}`);
      if (v.future && !NFT_DONE_STAGES.has(v.stage)) bits.push(L.nft.countdown(v.mintTs - nowMs));
      progress = bits.join(' · ');
    }
    const href = safeUrl(it.link) || (handle ? xUrl(handle) : '');
    const name = esc(it.project || handle);
    const head = href ? `<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${name}</a>` : `<b>${name}</b>`;
    const sec = T.sections[it.section] ? `<span class="badge badge-dim">${esc(T.sections[it.section])}</span>` : '';
    const track = row ? `<a class="ptrack" href="${pageHref('nft', L)}#nft-${esc(handle.toLowerCase())}">${T.track}</a>` : '';
    const dl = dlRows([
      [T.rowAction, tr(it, 'action')],
      [T.rowStatus, tr(it, 'status'), 'row-verdict'],
      [T.rowProgress, progress],
      [T.rowNext, tr(it, 'next')],
      [T.rowDate, it.date],
    ]);
    return `<li class="pitem"><div class="pitem-head">${head}${sec}</div><dl class="pdl">${dl}</dl>${track}</li>`;
  });
  return `<section class="panel" aria-labelledby="participation-title"><h2 class="panel-title" id="participation-title">${T.title}</h2><p class="panel-note">${T.note}</p>`
    + (lis.length ? `<ol class="plist">${lis.join('')}</ol>` : `<p class="panel-note">${T.empty}</p>`) + `</section>`;
}

// ---------- 置顶卡:站长自营项目(pinned.json) ----------
async function loadPinned() {
  try {
    const d = JSON.parse(await fs.readFile(PINNED_PATH, 'utf8'));
    return Array.isArray(d.items) ? d.items : [];
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[airdrop-site] pinned.json unreadable: ${err?.message || err}`);
    return [];
  }
}
/** until(北京时间日期,含当天)一过就自动不再显示;order 升序 */
function activePinned(items, nowMs) {
  return items
    .filter((it) => {
      const end = it.until ? isoToMs(`${it.until}T23:59:59+08:00`) : null;
      return end == null || end >= nowMs;
    })
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}
const pinTr = (o, k, L) => (L.code === 'en' && o?.[`${k}En`] != null && (Array.isArray(o[`${k}En`]) || has(o[`${k}En`])) ? o[`${k}En`] : Array.isArray(o?.[k]) ? o[k].map((x) => tx(x, L)) : tx(o?.[k], L));
/** 关键日期:按构建时刻定位当前阶段并高亮,再给一句「距下一阶段还有 N 天」 */
function pinnedPhases(it, nowMs, L) {
  const list = (Array.isArray(it.phases) ? it.phases : [])
    .map((p) => ({ ...p, ts: isoToMs(p.at) }))
    .filter((p) => p.ts != null)
    .sort((a, b) => a.ts - b.ts);
  let cur = -1;
  for (let i = 0; i < list.length; i++) if (list[i].ts <= nowMs) cur = i;
  const next = list[cur + 1] || null;
  const line = next ? L.pin.until(plain(pinTr(next, 'label', L)), next.ts - nowMs)
    : cur >= 0 ? L.pin.ongoing(plain(pinTr(list[cur], 'label', L))) : '';
  const chips = list.map((p, i) => {
    const note = has(pinTr(p, 'note', L)) ? ` <small>${esc(plain(pinTr(p, 'note', L)))}</small>` : '';
    return `<li class="pin-phase${i === cur ? ' is-now' : ''}"><b>${esc(plain(pinTr(p, 'label', L)))}</b>`
      + `<time datetime="${new Date(p.ts).toISOString()}">${esc(fmtDateTime(p.ts, L))}</time>${note}</li>`;
  }).join('');
  return { chips, line };
}
/** 四个页面主内容最顶部的置顶卡;没有在期条目就整块不渲染 */
function renderPinned(items, nowMs, L) {
  if (!items.length) return '';
  const T = L.pin;
  const cards = items.map((it) => {
    const links = (Array.isArray(it.links) ? it.links : [])
      .map((x) => [safeUrl(x.url), plain(pinTr(x, 'label', L)), x.primary])
      .filter(([u, label]) => u && label)
      .map(([u, label, primary]) => `<a class="link-chip${primary ? ' link-primary' : ''}" href="${esc(u)}" target="_blank" rel="noopener">${esc(label)}</a>`)
      .join('');
    const tagList = pinTr(it, 'tags', L);
    const tags = (Array.isArray(tagList) ? tagList : []).slice(0, 4)
      .map((x) => `<span class="badge badge-testnet">${esc(plain(x))}</span>`).join('');
    const art = safeUrl(it.image)
      ? `<div class="pin-art"><img src="${esc(it.image)}" alt="${esc(plain(it.imageAlt || it.name || ''))}" loading="lazy" decoding="async" width="1200" height="630"></div>`
      : '';
    const { chips, line } = pinnedPhases(it, nowMs, L);
    const badge = plain(pinTr(it, 'badge', L)) || T.badge;
    return `<article class="panel pin">${art}<div class="pin-body">`
      + `<div class="pin-head"><h2 class="pin-name">${esc(plain(it.name))}</h2><span class="badge badge-mine">${esc(badge)}</span>${tags}</div>`
      + (has(pinTr(it, 'tagline', L)) ? `<p class="pin-tagline">${esc(plain(pinTr(it, 'tagline', L)))}</p>` : '')
      + (has(pinTr(it, 'blurb', L)) ? `<p class="pin-blurb">${esc(plain(pinTr(it, 'blurb', L)))}</p>` : '')
      + (chips ? `<ul class="pin-phases">${chips}</ul>` : '')
      + (line ? `<p class="pin-line">${esc(line)} <small>${esc(T.tzNote)}</small></p>` : '')
      + (links ? `<nav class="links pin-links" aria-label="${esc(T.label)}">${links}</nav>` : '')
      + `<p class="pin-note">${esc(T.note)}</p></div></article>`;
  }).join('');
  return `<section class="pinned" aria-label="${esc(T.label)}">${cards}</section>`;
}

// ---------- 页面拼装 ----------
/** 每个页面在两种语言下的路径(相对站根,不带前导 /) */
const PAGE_PATH = { airdrop: '', btt: 'btt/', celeb: 'celeb/', nft: 'nft/' };
const pageHref = (page, L) => `/${L.dir}${PAGE_PATH[page]}`;
const pageUrl = (page, L) => `${SITE_URL}${L.dir}${PAGE_PATH[page]}`;

function nav(active, counts, L) {
  const item = (href, key, label, n) =>
    `<a class="cat" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}<small>${n}</small></a>`;
  const other = LOCALES[L.switchLang];
  return `<div class="navwrap"><nav class="cats" aria-label="${L.navLabel}">${item(pageHref('airdrop', L), 'airdrop', L.navAirdrop, counts.airdrop)}${item(pageHref('btt', L), 'btt', L.navBtt, counts.btt)}${item(pageHref('celeb', L), 'celeb', L.navCeleb, counts.celeb)}${item(pageHref('nft', L), 'nft', L.navNft, counts.nft)}</nav>`
    + `<a class="lang-switch" href="${pageHref(active, other)}" hreflang="${other.htmlLang}" lang="${other.htmlLang}" data-lang="${other.code}">${L.switchLabel}</a></div>`;
}
function stat(value, label) {
  return `<div class="stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
}
function tab(filter, label, n, pressed) {
  return `<button class="tab" type="button" data-filter="${filter}" aria-pressed="${pressed ? 'true' : 'false'}">${label}<small>${n}</small></button>`;
}
const LANG_NOTE_SLOT = '<!--LANG_NOTE-->';
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
    // 英文页的"仍有中文"提示只在本页确实有缺译时出现(缺译在渲染卡片时才知道,先放占位,渲染完再替换)
    LANG_NOTE: L[page].langNote ? LANG_NOTE_SLOT : '',
    T_FILTER: L.filterLabel,
    T_SORT: L.sortLabel,
    T_EMPTY: L.empty,
    TOP: '',
    FRIENDS: `${esc(L.friendsLabel)} ` + FRIEND_URLS.map((href, i) => `<a href="${href}" rel="noopener">${esc(L.friends[i])}</a>`).join(' · '),
    FOOTER_SYNC: L.footerSync(`<time datetime="${new Date(generatedTs).toISOString()}">${fmtDateTime(generatedTs, L)}</time>`),
  };
}

/** JSON-LD:Organization + WebSite + WebPage + 本页列表前 20 项,一段 @graph;`<` 转义,免得条目文本里出现 </script> */
function jsonLd(page, L, { title, description, generatedTs, listName, items }) {
  const site = `${SITE_URL}${L.dir}`;
  const url = pageUrl(page, L);
  const graph = [
    { '@type': 'Organization', '@id': `${ORG_URL}#organization`, name: 'SatLoot', url: ORG_URL, sameAs: [GITHUB_URL, 'https://x.com/eth61675'] },
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
  await loadI18n();
  const [projects, status, reports, btt, celeb, nft] = await Promise.all([
    getJson('/api/airdrop/projects?limit=1000', 'projects.json'),
    getJson('/api/airdrop/status', 'status.json'),
    getJson('/api/airdrop/reports?limit=10', 'reports.json'),
    loadBtt(),
    loadCeleb(),
    loadNft(),
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
  const nftRows = Array.isArray(nft?.rows) ? nft.rows.slice() : [];
  const nftViews = new Map(nftRows.map((p) => [p, nftView(p, generatedTs)]));
  const nv = (p) => nftViews.get(p);
  nftRows.sort((a, b) => nv(b).soonKey - nv(a).soonKey || Number(nv(b).curated) - Number(nv(a).curated) || (nv(b).score ?? -1) - (nv(a).score ?? -1) || (a.firstSeenTs || 0) - (b.firstSeenTs || 0));
  const nftWl = nftRows.filter((p) => nv(p).stage === '白名单申请中').length;
  const nftSoon = nftRows.filter((p) => nv(p).soon).length;
  const nftChanged = nftRows.filter((p) => nv(p).changed).length;
  const nftCurated = nftRows.filter((p) => nv(p).curated).length;
  const nftDiscovered = nftRows.length - nftCurated;
  const nftLastOk = isoToMs(nft?.lastTrackAt);
  const hrs = (v, dflt) => (Number.isFinite(v) ? Math.round(v / 3600) : dflt);
  const nftTiers = {
    nearApplied: hrs(nft?.appliedNearTrackEverySec, 1),
    near: hrs(nft?.nearTrackEverySec, 4),
    dated: hrs(nft?.trackEverySec, 12),
    wl: hrs(nft?.wlTrackEverySec, 24),
    quiet: hrs(nft?.quietTrackEverySec, 48),
  };
  const nftDiscoverHours = nft?.discoverEverySec ? Math.round(nft.discoverEverySec / 3600) : 0;
  const counts = { airdrop: rows.length, btt: bttTotal, celeb: celebTotal, nft: nftRows.length };
  const pinned = activePinned(await loadPinned(), generatedTs);
  const pinnedTop = (L) => renderPinned(pinned, generatedTs, L);
  const participation = await loadParticipation();
  const nftByHandle = new Map(nftRows.map((p) => [String(p.handle || '').toLowerCase(), p]));
  const appliedHandles = new Set(participation.filter((it) => it.section === 'nft')
    .map((it) => String(it.handle || '').replace(/^@/, '').toLowerCase()).filter(Boolean));
  const nftToday = nftRows.filter((p) => mintDayKey(p) === fmtIsoDate(generatedTs) && !NFT_DONE_STAGES.has(nv(p).stage)).length;
  // 右侧栏:先近期铸造,再参与表
  const sidebar = (L) => renderCalendarPanel(nftRows, generatedTs, L, appliedHandles) + renderSidebar(participation, nftByHandle, generatedTs, L);

  const template = await fs.readFile(path.join(__dirname, 'template.html'), 'utf8');

  // ---- 空投项目页 ----
  const airdropPage = (L) => {
    const T = L.airdrop;
    const description = T.description(rows.length, fmtDateTime(latestOkTs, L));
    return render(template, {
      ...pageCommon('airdrop', L, generatedTs),
      SIDEBAR: sidebar(L),
      TOP: pinnedTop(L),
      PAGE_TITLE: T.title,
      DESCRIPTION: description,
      JSON_LD: jsonLd('airdrop', L, { title: T.title, description, generatedTs, listName: T.heroTitle, items: rows.slice(0, 20).map((r) => ({ name: txf(r, 'name', L) })) }),
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
      SIDEBAR: sidebar(L),
      TOP: pinnedTop(L),
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
      SIDEBAR: sidebar(L),
      TOP: pinnedTop(L),
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

  // ---- NFT 打新机会页 ----
  const nftPage = (L) => {
    const T = L.nft;
    let cards;
    if (!nft) {
      cards = `<p class="empty-initial">${T.emptyOffline}</p>`;
    } else if (!nftRows.length) {
      cards = `<p class="empty-initial">${T.emptyNoRows}</p>`;
    } else {
      cards = nftRows.map((p) => renderNftCard(p, generatedTs, L)).join('\n');
    }
    // 核查报错原文可能是一整段 JSON,截短再显示
    const nftErr = plain(nft?.lastError || '').replace(/\s*\{[\s\S]*$/, '').slice(0, 120);
    const health = nft && nft.failStreak > 0 ? `<span class="warn">${T.health(nft.failStreak, esc(nftErr))}</span>` : '';
    const description = nft ? T.description(nftRows.length, nftWl, nftSoon, fmtDateTime(nftLastOk, L)) : T.descriptionOffline;
    return render(template, {
      ...pageCommon('nft', L, generatedTs),
      SIDEBAR: sidebar(L),
      PAGE_TITLE: T.title,
      DESCRIPTION: description,
      JSON_LD: jsonLd('nft', L, { title: T.title, description, generatedTs, listName: T.heroTitle, items: nftRows.slice(0, 20).map((p) => ({ name: tx(nv(p).name, L), url: xUrl(p.handle) })) }),
      NAV: nav('nft', counts, L),
      HERO_TITLE: T.heroTitle,
      HERO_LEDE: T.heroLede(nftTiers, nftDiscoverHours) + health,
      STATS: [
        stat(nft ? nftRows.length : '—', T.statTotal),
        stat(nft ? nftWl : '—', T.statWl),
        stat(nft ? nftSoon : '—', T.statSoon),
        stat(nft ? nftChanged : '—', T.statChanged),
        stat(fmtDateTime(nftLastOk, L), T.statLastCheck),
      ].join(''),
      TOP: pinnedTop(L) + renderCalendar(nftRows, generatedTs, L, appliedHandles),
      TABS: [tab('all', T.tabAll, nftRows.length, true), tab('todaymint', T.tabToday, nftToday), tab('curated', T.tabCurated, nftCurated), tab('wl', T.tabWl, nftWl), tab('soon', T.tabSoon, nftSoon), tab('changed', T.tabChanged, nftChanged), tab('discovered', T.tabDiscovered, nftDiscovered)].join(''),
      SORT_OPTIONS: `<option value="mint">${T.sortSoon}</option><option value="change">${T.sortChanged}</option><option value="score">${T.sortScore}</option><option value="first">${T.sortFirst}</option><option value="name">${T.sortName}</option>`,
      SEARCH_PLACEHOLDER: T.searchPlaceholder,
      CARDS: cards,
      FOOTER_NOTE: T.footerNote(),
    });
  };

  await fs.mkdir(OUT_DIR, { recursive: true });
  const pageFns = { airdrop: airdropPage, btt: bttPage, celeb: celebPage, nft: nftPage };
  for (const L of [LOCALES.zh, LOCALES.en]) {
    for (const [page, fn] of Object.entries(pageFns)) {
      I18N.page = page;
      const html = fn(L);
      const missing = I18N.miss[page]?.size || 0;
      const note = L.code === 'en' && missing ? `<p class="langnote">${esc(L[page].langNote)}</p>` : '';
      await writeAtomic(path.join(OUT_DIR, L.dir, PAGE_PATH[page], 'index.html'), html.replace(LANG_NOTE_SLOT, note));
    }
  }
  I18N.page = null;
  const missAll = new Set(Object.values(I18N.miss).flatMap((x) => [...x]));
  if (I18N_REPORT) {
    await writeAtomic(I18N_REPORT, JSON.stringify({
      generatedAt: new Date(generatedTs).toISOString(),
      cacheSize: I18N.map.size,
      hits: I18N.hits,
      missing: Object.fromEntries(Object.entries(I18N.miss).map(([k, v]) => [k, [...v]])),
    }, null, 1));
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
  if (nft) await writeAtomic(path.join(OUT_DIR, 'nft', 'data.json'), JSON.stringify(nft, null, 1));
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
    smUrl('nft', LOCALES.zh, nftLastOk ?? generatedTs, 'hourly') +
    smUrl('nft', LOCALES.en, nftLastOk ?? generatedTs, 'hourly') +
    `</urlset>\n`);
  console.log(`[airdrop-site] airdrop ${rows.length} (${testnetCount} testnet, ${newCount} new), btt ${btt ? `${bttTotal} posts (${bttToday} today, ${bttAnalyzed} analyzed)` : 'unavailable'}, celeb ${celeb ? `${celebTotal} events (${celebStrong} strong, ${celebToday} today)` : 'unavailable'}, nft ${nft ? `${nftRows.length} projects (${nftWl} wl open, ${nftSoon} soon, ${nftChanged} changed)` : 'unavailable'} ->${OUT_DIR} (zh + en; en cache ${I18N.map.size}, ${missAll.size} strings still Chinese)`);
}

main().catch((err) => {
  console.error('[airdrop-site] build failed:', err?.message || err);
  process.exit(1);
});
