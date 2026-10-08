#!/usr/bin/env node
// 已有拼豆图纸的照片 -> 高清可打印拼豆模板（逐格识别还原）
// 用法:
//   node photo2grid.mjs -i input/walnut.jpg --cols 49 --rows 59 \
//     --grid "14,209.45,9.3553,9.328" \
//     --codes "A10,A11,A15,D25,D6,F10,F11,F8,G13,G14,H1,H11,H18,H2,H20,H3,H7,H13" \
//     --counts "48,38,5,39,52,63,84,40,16,1,4,1682,3,193,1,16,550,56" \
//     --swatches "800,822,17;836,858,1" -o out/walnut
import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { renderSvg, renderLegendSvg, renderHtml, renderPreviewPng, renderChart, renderCsv } from './lib/render.mjs';
import {
  loadImageGray, lineSignal, crossSignal, traceLines, fitLines, extractSwatches, detectGridBands,
  sampleCells, classifyCells, balanceToCounts, renderCompare, rgbToLab, deltaE,
} from './lib/photo-grid.mjs';

const ALIAS = { i: 'input', o: 'out', t: 'title' };
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    if (a.length === 2 && a[0] === '-' && !a.startsWith('--')) a = `--${ALIAS[a[1]] || a[1]}`;
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let inline;
    if (key.includes('=')) { inline = key.slice(key.indexOf('=') + 1); key = key.slice(0, key.indexOf('=')); }
    if (inline !== undefined) { out[key] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
const num = (v, d) => (v === undefined || v === true ? d : Number(v));

if (!args.input || args.input === true) {
  console.error('缺少 --input <照片路径>');
  process.exit(1);
}
const inputPath = path.resolve(process.cwd(), String(args.input));
if (!fs.existsSync(inputPath)) {
  console.error(`照片不存在: ${inputPath}`);
  process.exit(1);
}

const cols = num(args.cols, 0);
const rows = num(args.rows, 0);
if (!(cols > 0 && rows > 0)) {
  console.error('缺少 --cols / --rows（图纸的列数与行数）');
  process.exit(1);
}

// ---------- 1. 网格几何 ----------
let geom;
if (args.grid && args.grid !== true) {
  const [x0, y0, tx, ty] = String(args.grid).split(',').map(Number);
  geom = { x0, y0, tx, ty };
  console.log(`网格(手动): 原点 ${x0},${y0}  格 ${tx}x${ty}px  ${cols}x${rows}`);
} else {
  // 自动：先定位网格区（排除黑边/标号/清单），再追踪网格线并做线性拟合
  const img0 = await Jimp.read(inputPath);
  const gi = loadImageGray(img0);
  const bands = args['fit-region'] && args['fit-region'] !== true
    ? (() => {
      const [x0, y0, x1, y1] = String(args['fit-region']).split(',').map(Number);
      return { page: { x0, y0, x1, y1 }, grid: { x0, y0, x1, y1 } };
    })()
    : detectGridBands(img0);
  const gb = bands.grid;
  const pb = bands.page;
  console.log(`纸面(自动): x ${pb.x0}..${pb.x1} y ${pb.y0}..${pb.y1}`);
  // 第一轮：整条网格带上找竖线
  const sx0 = lineSignal(gi, 'x', { y0: pb.y0 + 2, y1: pb.y1 - 2 });
  const tX0 = traceLines(sx0, 9.34, pb.x0, pb.x1, cols + 1);
  const FX0 = fitLines(tX0, cols + 1, sx0);
  // 第二轮：只在竖线交叉点上找横线（图案区/深色区不再打断）
  const vx = Array.from({ length: cols + 1 }, (_, k) => FX0.origin + FX0.period * k);
  const sy = crossSignal(gi, 'y', vx, pb.y0, pb.y1, 1);
  const FY = fitLines(traceLines(sy, 9.33, pb.y0, pb.y1, rows + 1), rows + 1, sy);
  // 第三轮：再用横线交叉点复核竖线
  const hy = Array.from({ length: rows + 1 }, (_, k) => FY.origin + FY.period * k);
  const sx = crossSignal(gi, 'x', hy, pb.x0, pb.x1, 1);
  const FX = fitLines(traceLines(sx, 9.34, pb.x0, pb.x1, cols + 1), cols + 1, sx);
  geom = { x0: FX.origin, y0: FY.origin, tx: FX.period, ty: FY.period };
  console.log(`网格(自动): x ${FX.origin.toFixed(2)} + ${FX.period.toFixed(4)}*k  (${FX.count}条线, rms ${FX.rms.toFixed(2)}px)`);
  console.log(`          y ${FY.origin.toFixed(2)} + ${FY.period.toFixed(4)}*k  (${FY.count}条线, rms ${FY.rms.toFixed(2)}px)`);
}

// ---------- 2. 色卡 ----------
const codes = String(args.codes || '').split(',').map((s) => s.trim()).filter(Boolean);
const img = await Jimp.read(inputPath);
let refs;
if (args.palette === 'fixed' || (args['no-swatch'])) {
  refs = codes.map((c, i) => ({ code: c, rgb: hexToRgbLocal(String(args['fixed-hex'] || '').split(',')[i] || '#888888') }));
} else {
  const sw = String(args.swatches || '').split(';').filter(Boolean).map((s) => {
    const [y0, y1, count] = s.split(',').map(Number);
    return { y0, y1, count };
  });
  if (!sw.length || !codes.length) {
    console.error('需要 --codes（色号顺序）和 --swatches "y0,y1,count;..."（材料清单色块所在行）');
    process.exit(1);
  }
  const total = sw.reduce((a, r) => a + r.count, 0);
  if (total !== codes.length) {
    console.error(`色块数 ${total} 与色号数 ${codes.length} 不一致`);
    process.exit(1);
  }
  const swatches = extractSwatches(img, sw);
  refs = swatches.map((s, i) => ({ code: codes[i], rgb: s.rgb, cx: s.cx }));
  console.log(`\n色卡(照片实测, 色块间距 ${swatches[0]?.spacing}px):`);
  refs.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)} ${r.code.padEnd(5)} #${r.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}  rgb(${r.rgb.map((v) => Math.round(v)).join(',')})`);
  });
}

// ---------- 3. 逐格取色 + 分类 ----------
const cells = sampleCells(img, geom, cols, rows);
const { assign, labs } = classifyCells(cells, refs, num(args.iter, 3));
const grid = Int16Array.from(assign);

// ---------- 4. 数量约束（材料清单是已知的强约束） ----------
const targetList = String(args.counts || '').split(',').map((s) => parseInt(s, 10));
let counts = refs.map(() => 0);
for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
if (targetList.length === codes.length && targetList.every((v) => Number.isFinite(v))) {
  const before = counts.slice();
  balanceToCounts(grid, labs, refs, targetList);
  counts = refs.map(() => 0);
  for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
  console.log(`\n数量约束前后对比 (色号: 清单 -> 校正前 -> 校正后):`);
  refs.forEach((r, i) => {
    const flag = before[i] === targetList[i] ? '  ' : ' *';
    console.log(`  ${r.code.padEnd(5)} ${String(targetList[i]).padStart(5)} -> ${String(before[i]).padStart(5)} -> ${String(counts[i]).padStart(5)}${flag}`);
  });
  console.log(`  合计   ${String(targetList.reduce((a, b) => a + b, 0)).padStart(5)} -> ${String(before.reduce((a, b) => a + b, 0)).padStart(5)} -> ${String(counts.reduce((a, b) => a + b, 0)).padStart(5)}`);
} else {
  console.log('\n(未提供 --counts，跳过数量约束校正)');
  refs.forEach((r, i) => console.log(`  ${r.code.padEnd(5)} x${counts[i]}`));
}

// ---------- 5. 输出 ----------
const outDir = path.resolve(process.cwd(), String(args.out || 'out/photo'));
fs.mkdirSync(outDir, { recursive: true });

// 按用量重排编号，主色排前面
function reorder(g, colors) {
  const cnt = colors.map(() => 0);
  for (let i = 0; i < g.length; i++) if (g[i] >= 0) cnt[g[i]]++;
  const order = colors.map((c, i) => i).filter((i) => cnt[i] > 0).sort((a, b) => cnt[b] - cnt[a]);
  const remap = new Int32Array(colors.length).fill(-1);
  order.forEach((from, to) => { remap[from] = to; });
  const out = new Int16Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = g[i] < 0 ? -1 : remap[g[i]];
  const cs = order.map((from, to) => ({ ...colors[from], label: String(to + 1).padStart(2, '0') }));
  const cn = order.map((from) => cnt[from]);
  return { grid: out, colors: cs, counts: cn };
}
const ro = reorder(grid, refs);
const finalGrid = ro.grid;
const colors = ro.colors.map((c) => ({
  code: c.code,
  name: '',
  hex: `#${c.rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
  label: c.label,
}));
const finalCounts = ro.counts;

const opts = {
  mode: args.mode === 'mono' ? 'mono' : 'color',
  shape: args.shape === 'square' ? 'square' : 'circle',
  labels: args.labels === undefined ? true : !!args.labels,
  gridLabel: '照片还原',
};
const cellMm = Math.max(1, Math.min(10, num(args['cell-mm'], 5)));
const total = finalCounts.reduce((a, b) => a + b, 0);
const title = String(args.title && args.title !== true ? args.title : path.basename(inputPath, path.extname(inputPath)));
const summary = `${cols} x ${rows} 格 | ${cellMm}mm 豆成品约 ${(cols * cellMm / 10).toFixed(1)} x ${(rows * cellMm / 10).toFixed(1)} cm | 共 ${total} 颗 | ${colors.filter((c, i) => finalCounts[i] > 0).length} 种颜色 | 色值取自照片材料清单`;

const legendSvg = renderLegendSvg({ colors, counts: finalCounts, opts });
const svg = renderSvg({ grid: finalGrid, W: cols, H: rows, colors, counts: finalCounts, opts });
fs.writeFileSync(path.join(outDir, 'pattern-a4.html'), renderHtml({ svg, legendSvg, meta: { title, summary, mode: opts.mode } }), 'utf8');
fs.writeFileSync(path.join(outDir, 'pattern.svg'), svg, 'utf8');
fs.writeFileSync(path.join(outDir, 'chart.txt'), '\ufeff' + renderChart({ grid: finalGrid, W: cols, H: rows, colors, counts: finalCounts, meta: { title, summary } }), 'utf8');
fs.writeFileSync(path.join(outDir, 'colors.csv'), '\ufeff' + renderCsv({ colors, counts: finalCounts }), 'utf8');
fs.writeFileSync(path.join(outDir, 'pattern.json'), JSON.stringify({
  title, width: cols, height: rows, beadMm: cellMm, source: inputPath,
  grid: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => colors[finalGrid[r * cols + c]].code)),
  colors: colors.map((c, i) => ({ code: c.code, hex: c.hex, label: c.label, count: finalCounts[i] })),
}, null, 2), 'utf8');
await renderPreviewPng({ grid: finalGrid, W: cols, H: rows, colors, scale: num(args.scale, 14), file: path.join(outDir, 'preview.png') });
if (args['no-compare'] !== true) {
  await renderCompare(img, geom, cols, rows, finalGrid, colors, path.join(outDir, 'compare.png'), num(args['compare-scale'], 5));
}

console.log(`\n完成 -> ${outDir}`);
console.log(summary);

function hexToRgbLocal(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
void rgbToLab;
void deltaE;