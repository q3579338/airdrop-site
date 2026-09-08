#!/usr/bin/env node
// airdrop.satloot.com 静态页生成器。
// 从 riskdesk 侧车(127.0.0.1:5177,本机直连即站主)拉空投项目存档,渲染成 index.html + data.json。
// 由 systemd 定时器每 10 分钟跑一次;侧车挂了就保留上一版文件,不会把站点写空。
//
// 环境变量:
//   AIRDROP_API_BASE     侧车地址,默认 http://127.0.0.1:5177
//   AIRDROP_OUT_DIR      输出目录,默认 ./dist
//   AIRDROP_FIXTURE_DIR  本地测试:从该目录读 projects.json / status.json / reports.json,不联网
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = (process.env.AIRDROP_API_BASE || 'http://127.0.0.1:5177').replace(/\/$/, '');
const OUT_DIR = process.env.AIRDROP_OUT_DIR || path.join(__dirname, 'dist');
const FIXTURE_DIR = process.env.AIRDROP_FIXTURE_DIR || null;
const SITE_URL = 'https://airdrop.satloot.com/';
const SOURCE_URL = 'https://earn.satloot.com/app/#/airdrop';
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
function fmtDate(ts) {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const o = partsIn(ts);
  return `${o.year}-${o.month}-${o.day}`;
}
function fmtDateTime(ts) {
  if (ts == null || !Number.isFinite(ts)) return '—';
  const o = partsIn(ts);
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`;
}
function fmtIsoDate(ts) {
  const o = partsIn(ts);
  return `${o.year}-${o.month}-${o.day}`;
}

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
const has = (s) => plain(s) !== '' && plain(s) !== '—' && plain(s) !== '无';

function renderCard(r, latestOkTs) {
  const isNew = latestOkTs != null && r.firstSeenTs >= latestOkTs;
  const testnet = r.testnetFlag === 'yes';
  const badges = [];
  if (testnet) badges.push('<span class="badge badge-testnet">测试网 BTC</span>');
  if (isNew) badges.push('<span class="badge badge-new">本次新发现</span>');
  if (r.seenCount > 1) badges.push(`<span class="badge badge-dim">第 ${r.seenCount} 次上榜</span>`);

  const fields = [
    ['链', r.chain],
    ['参与方式', r.participation],
    ['测试网', testnet ? r.testnetDetail : null],
    ['阶段 / 截止', r.deadline],
    ['热度证据', r.buzz],
    ['风险', r.risk],
  ].filter(([, v]) => has(v));
  const dl = fields
    .map(([k, v]) => `<div class="row${k === '风险' ? ' row-risk' : ''}"><dt>${esc(k)}</dt><dd>${esc(plain(v))}</dd></div>`)
    .join('');

  const search = [r.name, r.chain, r.participation, r.deadline, r.buzz, r.risk, r.testnetDetail]
    .map(plain).join(' ').toLowerCase();

  return `<article class="card" data-testnet="${testnet ? 1 : 0}" data-new="${isNew ? 1 : 0}" data-first="${r.firstSeenTs}" data-last="${r.lastSeenTs}" data-count="${r.seenCount}" data-search="${esc(search)}">
  <header class="card-head">
    <h2>${esc(r.name)}</h2>
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
  </header>
  <dl>${dl}</dl>
  <footer class="card-meta">
    <span title="第一次被雷达扫到的日期">首次发现 <time datetime="${fmtIsoDate(r.firstSeenTs)}">${fmtDate(r.firstSeenTs)}</time></span>
    <span>最近出现 <time datetime="${fmtIsoDate(r.lastSeenTs)}">${fmtDate(r.lastSeenTs)}</time></span>
    <span>上榜 ${r.seenCount} 次</span>
  </footer>
</article>`;
}

async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

async function main() {
  const [projects, status, reports] = await Promise.all([
    getJson('/api/airdrop/projects?limit=1000', 'projects.json'),
    getJson('/api/airdrop/status', 'status.json'),
    getJson('/api/airdrop/reports?limit=10', 'reports.json'),
  ]);
  const rows = Array.isArray(projects?.rows) ? projects.rows : [];
  if (projects?.mode !== 'rollup') throw new Error(`unexpected projects mode: ${projects?.mode}`);

  // "本次新发现" = 首见时间落在最近一次成功扫描上。以成功报告为准,失败的扫描不算。
  const okTs = (reports?.rows ?? []).filter((x) => x.ok === 1 && Number.isFinite(x.ts)).map((x) => x.ts);
  let latestOkTs = okTs.length ? Math.max(...okTs) : null;
  if (latestOkTs == null && status?.lastOk && Number.isFinite(status?.lastRunTs)) latestOkTs = status.lastRunTs;

  rows.sort((a, b) => b.firstSeenTs - a.firstSeenTs || b.seenCount - a.seenCount || a.name.localeCompare(b.name, 'zh'));
  const testnetCount = rows.filter((r) => r.testnetFlag === 'yes').length;
  const newCount = latestOkTs == null ? 0 : rows.filter((r) => r.firstSeenTs >= latestOkTs).length;
  const generatedTs = Date.now();

  const template = await fs.readFile(path.join(__dirname, 'template.html'), 'utf8');
  const vars = {
    SITE_URL,
    SOURCE_URL,
    TOTAL: String(rows.length),
    TESTNET_COUNT: String(testnetCount),
    NEW_COUNT: String(newCount),
    LATEST_SCAN: fmtDateTime(latestOkTs),
    NEXT_SCAN: fmtDateTime(status?.nextRunTs),
    GENERATED: fmtDateTime(generatedTs),
    GENERATED_ISO: new Date(generatedTs).toISOString(),
    CARDS: rows.length
      ? rows.map((r) => renderCard(r, latestOkTs)).join('\n')
      : '<p class="empty-initial">雷达还没有产出任何项目,稍后再来。</p>',
    DESCRIPTION: `${rows.length} 个正在进行的加密空投项目:链、参与方式、阶段、热度证据与风险,按项目去重并标注首次发现日期。最近扫描 ${fmtDateTime(latestOkTs)}(北京时间)。`,
  };
  const html = template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

  await fs.mkdir(OUT_DIR, { recursive: true });
  await writeAtomic(path.join(OUT_DIR, 'index.html'), html);
  await writeAtomic(path.join(OUT_DIR, 'data.json'), JSON.stringify({
    generatedAt: new Date(generatedTs).toISOString(),
    latestScanAt: latestOkTs == null ? null : new Date(latestOkTs).toISOString(),
    nextScanAt: Number.isFinite(status?.nextRunTs) ? new Date(status.nextRunTs).toISOString() : null,
    source: SOURCE_URL,
    count: rows.length,
    rows,
  }, null, 1));
  await writeAtomic(path.join(OUT_DIR, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
  await writeAtomic(path.join(OUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}</loc><lastmod>${fmtIsoDate(latestOkTs ?? generatedTs)}</lastmod><changefreq>daily</changefreq></url>\n</urlset>\n`);
  console.log(`[airdrop-site] ${rows.length} projects (${testnetCount} testnet, ${newCount} new) -> ${OUT_DIR}; latest scan ${fmtDateTime(latestOkTs)}`);
}

main().catch((err) => {
  console.error('[airdrop-site] build failed:', err?.message || err);
  process.exit(1);
});
