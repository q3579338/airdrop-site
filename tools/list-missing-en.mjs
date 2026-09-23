#!/usr/bin/env node
// 列出英文页里仍回落中文的数据原文(缺译),并可把补好的译文并回缓存 data/i18n-en.json。
//
// 做法:拿一份数据(默认拉线上 https://airdrop.satloot.com/ 公开的四个 data.json;或 --fixture 指本地样例目录),
// 用同一个 build.mjs 生成到临时目录,生成器按页面汇报哪些原文没命中缓存 —— 与线上渲染逻辑完全一致,不会漏也不会多。
//
// 用法:
//   node tools/list-missing-en.mjs                         # 拉线上数据,打印各页缺译条数 + 英文页中文残留统计
//   node tools/list-missing-en.mjs --out todo.json         # 另把缺译写成骨架 {"中文原文": ""},填好英文后用 --merge 并回
//   node tools/list-missing-en.mjs --page airdrop,celeb    # 只看某几页(airdrop / btt / celeb / nft / other)
//   node tools/list-missing-en.mjs --fixture ./fixture     # 用本地样例数据,不联网
//   node tools/list-missing-en.mjs --print                 # 把缺译原文逐条打印出来
//   node tools/list-missing-en.mjs --merge todo.json       # 把填好的译文(空串跳过)并入 data/i18n-en.json,键排序后写回
//
// 本机若直连不通(DNS 污染),先在别处把四个 data.json 存下来,按 --fixture 的文件名放进一个目录再跑。
// 翻译约定:专有名词 / 代币名 / 项目名 / 链名保持原样;人工翻译,不走机器翻译 API。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.AIRDROP_I18N_EN || path.join(ROOT, 'data', 'i18n-en.json');
const SITE = 'https://airdrop.satloot.com/';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

async function readCache() {
  try {
    const d = JSON.parse(await fs.readFile(CACHE, 'utf8'));
    return { readme: d._readme, entries: d.entries || {} };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return { readme: undefined, entries: {} };
  }
}
async function writeCache({ readme, entries }) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'zh')));
  await fs.mkdir(path.dirname(CACHE), { recursive: true });
  const tmp = `${CACHE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify({ _readme: readme, entries: sorted }, null, 1)}\n`, 'utf8');
  await fs.rename(tmp, CACHE);
}

// ---- --merge:把填好的骨架并回缓存 ----
if (opt('--merge')) {
  const src = JSON.parse(await fs.readFile(opt('--merge'), 'utf8'));
  const add = src.entries && typeof src.entries === 'object' ? src.entries : src;
  const cache = await readCache();
  let added = 0, changed = 0, skipped = 0;
  for (const [zh, en] of Object.entries(add)) {
    if (zh.startsWith('_')) continue;
    const k = String(zh).replace(/\s+/g, ' ').trim();
    const v = typeof en === 'string' ? en.trim() : '';
    if (!k || !v) { skipped++; continue; }
    if (!(k in cache.entries)) added++;
    else if (cache.entries[k] !== v) changed++;
    cache.entries[k] = v;
  }
  await writeCache(cache);
  console.log(`merged into ${CACHE}: +${added} new, ${changed} updated, ${skipped} empty skipped, ${Object.keys(cache.entries).length} total`);
  process.exit(0);
}

// ---- 准备数据 ----
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'airdrop-i18n-'));
let fixtureDir = opt('--fixture') ? path.resolve(opt('--fixture')) : null;
if (!fixtureDir) {
  fixtureDir = path.join(work, 'fixture');
  await fs.mkdir(fixtureDir, { recursive: true });
  const get = async (p) => {
    const res = await fetch(SITE + p, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${SITE}${p}`);
    return res.json();
  };
  const [air, btt, celeb, nft] = await Promise.all(['data.json', 'btt/data.json', 'celeb/data.json', 'nft/data.json'].map(get));
  const scanTs = Date.parse(air.latestScanAt) || null;
  const w = (f, o) => fs.writeFile(path.join(fixtureDir, f), JSON.stringify(o), 'utf8');
  await Promise.all([
    w('projects.json', { mode: 'rollup', rows: air.rows || [] }),
    w('status.json', { lastOk: scanTs != null, lastRunTs: scanTs, nextRunTs: Date.parse(air.nextScanAt) || null }),
    w('reports.json', { rows: scanTs != null ? [{ ok: 1, ts: scanTs }] : [] }),
    w('btt-export.json', btt),
    w('celeb-export.json', celeb),
    w('nft-export.json', nft),
  ]);
  console.log(`live data: ${air.rows?.length ?? 0} airdrops, ${btt.rows?.length ?? 0} btt, ${celeb.rows?.length ?? 0} celeb, ${nft.rows?.length ?? 0} nft`);
}

// ---- 用同一个生成器渲染,拿缺译报告 ----
const outDir = path.join(work, 'dist');
const report = path.join(work, 'i18n-report.json');
const run = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], {
  env: { ...process.env, AIRDROP_FIXTURE_DIR: fixtureDir, AIRDROP_OUT_DIR: outDir, AIRDROP_I18N_REPORT: report, AIRDROP_I18N_EN: CACHE },
  encoding: 'utf8',
});
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(1);
}
const rep = JSON.parse(await fs.readFile(report, 'utf8'));
const pages = opt('--page') ? opt('--page').split(',').map((s) => s.trim()) : Object.keys(rep.missing).concat(Object.keys(rep.hits)).filter((v, i, a) => a.indexOf(v) === i);

// 英文页里的中文残留(文本节点,不含脚本/样式/属性)——与缺译条数互相印证
async function residual(file) {
  let html;
  try { html = await fs.readFile(file, 'utf8'); } catch { return null; }
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const nodes = [...body.matchAll(/>([^<>]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  const cjk = nodes.filter((t) => /[㐀-鿿]/.test(t));
  return { nodes: nodes.length, cjkNodes: cjk.length, cjkChars: cjk.join('').match(/[㐀-鿿]/g)?.length || 0 };
}
const PAGE_FILE = { airdrop: 'en/index.html', btt: 'en/btt/index.html', celeb: 'en/celeb/index.html', nft: 'en/nft/index.html' };

console.log(`cache ${CACHE}: ${rep.cacheSize} entries`);
const todo = {};
for (const pg of pages) {
  const miss = rep.missing[pg] || [];
  const r = PAGE_FILE[pg] ? await residual(path.join(outDir, PAGE_FILE[pg])) : null;
  console.log(`${pg.padEnd(8)} missing ${String(miss.length).padStart(5)}  (cache hits ${rep.hits[pg] || 0})`
    + (r ? `  | /${PAGE_FILE[pg].replace('index.html', '')}: ${r.cjkNodes}/${r.nodes} text nodes still Chinese, ${r.cjkChars} CJK chars` : ''));
  for (const zh of miss) todo[zh] = '';
  if (flag('--print')) for (const zh of miss) console.log(`  - ${zh}`);
}
console.log(`total distinct missing: ${Object.keys(todo).length}`);
if (opt('--out')) {
  await fs.writeFile(opt('--out'), `${JSON.stringify(todo, null, 1)}\n`, 'utf8');
  console.log(`skeleton written: ${opt('--out')} (fill the English values, then: node tools/list-missing-en.mjs --merge ${opt('--out')})`);
}
await fs.rm(work, { recursive: true, force: true });
