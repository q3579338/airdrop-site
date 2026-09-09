#!/usr/bin/env node
// 生成 OG 分享图 static/og.png(1200×630,浅色底:站名 + 一句英文标语 + 域名)。
// 只在本机跑一次、产物进 git;build.mjs 每次生成时把 static/ 原样复制到输出目录,定时生成只写具体文件、不清目录,不会冲掉它。
// 渲染用 @resvg/resvg-js(借 bnbbang 仓库里装好的那份,免再装依赖;可用 RESVG_MODULE 指到别处),字体只用系统字体。
// 用法:node tools/make-og.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Resvg } = require(process.env.RESVG_MODULE || 'D:/CLAUDE/bnbbang/server/node_modules/@resvg/resvg-js');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'og.png');

// resvg 在 Windows 上取不到 Segoe UI 的粗体变体,标题用微软雅黑 700(中英都有粗体);正文与域名用 Segoe UI
const BOLD = 'Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif';
const TEXT = 'Segoe UI, Microsoft YaHei, sans-serif';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf9f4"/><stop offset="1" stop-color="#f3f0e8"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <!-- 右侧:favicon 同款同心圆(雷达) -->
  <g transform="translate(1035 315)">
    <circle r="150" fill="#fff4e0"/>
    <circle r="150" fill="none" stroke="#f2c979" stroke-width="2"/>
    <circle r="106" fill="#f59e0b"/>
    <circle r="64" fill="none" stroke="#fff7ed" stroke-width="14"/>
    <circle r="21" fill="#fff7ed"/>
  </g>
  <g font-family="${TEXT}">
    <circle cx="90" cy="128" r="9" fill="#b45309"/>
    <text x="112" y="136" font-family="${BOLD}" font-size="22" font-weight="700" fill="#6b665c" letter-spacing="2">SATLOOT · 空投雷达</text>
    <text x="80" y="262" font-family="${BOLD}" font-size="66" font-weight="700" fill="#1f1d1a">SatLoot Airdrop Radar</text>
    <text x="80" y="338" font-size="34" fill="#6b665c">Ongoing crypto airdrops and new BTT altcoin</text>
    <text x="80" y="384" font-size="34" fill="#6b665c">threads, deduplicated and tracked daily.</text>
    <line x1="80" y1="494" x2="740" y2="494" stroke="#e6e1d6" stroke-width="2"/>
    <text x="80" y="548" font-family="${BOLD}" font-size="30" font-weight="700" fill="#b45309">airdrop.satloot.com</text>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes, 1200×630)`);
