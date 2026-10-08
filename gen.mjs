#!/usr/bin/env node
// 拼豆图纸生成器：图片 -> 30x30 / 45x45 拼豆图纸
// 用法: node gen.mjs --input pic.png --size 30 --palette midi
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp, ResizeStrategy } from 'jimp';
import { loadPalette } from './lib/palette.mjs';
import { hexToRgb, rgbToLab, deltaE, adjust, kmeansLab, despeckle, dropRare, countColors, flattenBackground, findOutlineMask, cutOutBackground } from './lib/color.mjs';
import { renderSvg, renderLegendSvg, renderHtml, renderPreviewPng, renderChart, renderCsv } from './lib/render.mjs';

const ALIAS = { i: 'input', s: 'size', p: 'palette', o: 'out', t: 'title', n: 'max-colors', m: 'mode' };

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i];
    if (a.length === 2 && a[0] === '-' && !a.startsWith('--')) a = `--${ALIAS[a[1]] || a[1]}`;
    if (!a.startsWith('--')) continue;
    let key = a.slice(2);
    let inline;
    if (key.includes('=')) { inline = key.slice(key.indexOf('=') + 1); key = key.slice(0, key.indexOf('=')); }
    if (key === 'override') { out.override = true; if (inline) out.overrideValue = inline; continue; }
    if (key === 'no-legend') { out.legend = false; continue; }
    if (key === 'list-palette') { out.listPalette = true; continue; }
    if (inline !== undefined) { out[key] = inline; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
const num = (v, d) => (v === undefined || v === true ? d : Number(v));

const overrideIdx = process.argv.indexOf('--override');
const overrideVal = args.overrideValue || (overrideIdx > -1 && process.argv[overrideIdx + 1] && !process.argv[overrideIdx + 1].startsWith('--') ? process.argv[overrideIdx + 1] : '');
const palette = loadPalette(args.palette || 'midi', overrideVal);

if (args['list-palette']) {
  console.log(`色卡: ${palette.name} (${palette.colors.length} 色)`);
  palette.colors.forEach((c) => console.log(`  ${c.code.padEnd(6)} ${(c.name || '').padEnd(6, '　')} ${c.hex}`));
  process.exit(0);
}

if (!args.input || args.input === true) {
  console.error('缺少 --input <图片路径>');
  console.error('示例: node gen.mjs --input d:/pics/cat.png --size 45 --palette midi --mode mono');
  process.exit(1);
}

const inputPath = path.resolve(process.cwd(), String(args.input));
if (!fs.existsSync(inputPath)) {
  console.error(`图片不存在: ${inputPath}`);
  process.exit(1);
}

const sizeArg = String(args.size || 30);
const [W, H] = sizeArg.includes('x') ? sizeArg.split('x').map(Number) : [Number(sizeArg), Number(sizeArg)];
if (!(W > 0 && H > 0 && W <= 200 && H <= 200)) {
  console.error(`尺寸非法: ${sizeArg}`);
  process.exit(1);
}

const maxColors = Math.max(2, Math.min(99, num(args['max-colors'], 24)));
const despeckleLevel = Math.max(0, Math.min(3, num(args.despeckle, 1)));
const minCount = Math.max(0, num(args['min-count'], 0));
const scale = Math.max(4, Math.min(40, num(args.scale, 12)));
const buffer = Math.max(0, Math.min(0.4, num(args.buffer, 0)));
const opts = {
  mode: args.mode === 'mono' ? 'mono' : 'color',
  shape: args.shape === 'square' ? 'square' : 'circle',
  labels: !!args.labels,
  gridLabel: '图纸编号',
};

const image = await Jimp.read(inputPath);

// 0) --crop x,y,w,h：先按原图像素裁出主体（去掉背景），再缩放。
// 裁成方形框可以避免后面 cover 二次裁切把人物切掉。
const cropArg = String(args.crop || '').split(',').map(Number);

// 0) --subject：用 U2-Net 抠出人物主体，背景换成纯色，再进入后面的流程。
// 这是给「人和背景同色、自动分割失效」的图准备的：模型负责定位人物，
// 低饱和度区域生长负责把白衬衫/皮肤接上，低置信度像素直接画成背景色。
// 分割结果已经裁到人物外接框，所以这里会忽略 --crop。
let base = image.clone();
if (args.subject) {
  const { segmentSubject, compositeOnColor } = await import('./lib/subject.mjs');
  const modelFile = String(args['subject-model'] === true ? 'models/u2net.onnx' : args['subject-model'] || 'models/u2net.onnx');
  const modelPath = path.resolve(process.cwd(), modelFile);
  if (!fs.existsSync(modelPath)) {
    console.error(`找不到分割模型: ${modelPath}\n请先下载 u2net.onnx 到 models/ 目录`);
    process.exit(1);
  }
  const fill = String(args['subject-fill'] === true ? '#FFFFFF' : args['subject-fill'] || '#FFFFFF');
  const tmpPath = path.join(os.tmpdir(), `pindou-subject-${process.pid}.png`);
  const t0 = Date.now();
  const seg = await segmentSubject(inputPath, modelPath, {
    stretch: false,
    alphaFloor: num(args['subject-floor'], 0.5),
    closeR: num(args['subject-close'], 6),
    grow: num(args['subject-grow'], 18),
    edgeDepth: num(args['subject-edge'], 5),
    openR: num(args['subject-open'], 4),
    darkL: num(args['subject-dark'], 28),
    brightL: num(args['subject-bright'], 242),
    bgDeltaE: num(args['subject-bgdelta'], 16),
    wipeDist: num(args['subject-wipe'], 24),
    wipeConf: num(args['subject-wipeconf'], 0.45),
  });
  const box = await compositeOnColor(inputPath, seg, tmpPath, fill, {
    lowConf: num(args['subject-lowconf'], 0.18),
    pad: num(args['subject-pad'], 0.03),
    // --subject-blank：背景保持透明，图纸上留空不放豆（比填白色省一大截豆子）
    keepAlpha: !!args['subject-blank'],
  });
  base = await Jimp.read(tmpPath);
  try { fs.unlinkSync(tmpPath); } catch { /* 临时文件清理失败无所谓 */ }
  console.log(`人物分割: ${seg.width}x${seg.height} -> ${box.width}x${box.height}  背景 ${fill}  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else if (cropArg.length === 4 && cropArg.every(Number.isFinite)) {
  base = image.clone().crop({
    x: Math.max(0, Math.round(cropArg[0])),
    y: Math.max(0, Math.round(cropArg[1])),
    w: Math.max(1, Math.round(cropArg[2])),
    h: Math.max(1, Math.round(cropArg[3])),
  });
}
if (args.crop && !args.subject) console.log(`裁剪: ${cropArg.join(',')}  -> ${base.bitmap.width}x${base.bitmap.height}`);

// 0.5) --bg-cut N：在原图分辨率上抠掉背景（背景像素转透明 -> 图纸上留空，不放豆）。
// 必须放在缩放之前，缩放会把勾边线抹掉导致分割失败。
const bgCut = num(args['bg-cut'], 0);
if (bgCut > 0) {
  // 背景色从「未裁剪的原图」四周采样：原图最外圈才是真正的背景，
  // 而 --crop 之后的图最外圈已经是人物/头发了。
  const cutK = Math.max(1, Math.min(6, bgCut | 0));
  const ow = image.bitmap.width;
  const oh = image.bitmap.height;
  const od = image.bitmap.data;
  const oat = (x, y) => [od[(y * ow + x) * 4], od[(y * ow + x) * 4 + 1], od[(y * ow + x) * 4 + 2]];
  const oborder = [];
  // 采样环要够宽：很多图最外圈有 3~6px 的描边/外框，环太窄会只学到边框色
  const cutRing = Math.max(1, Math.min(40, num(args['bg-cut-ring'], 14)));
  for (let x = 0; x < ow; x++) for (let r = 0; r < cutRing; r++) oborder.push(oat(x, r), oat(x, oh - 1 - r));
  for (let y = 0; y < oh; y++) for (let r = 0; r < cutRing; r++) oborder.push(oat(r, y), oat(ow - 1 - r, y));
  const bgCenters = kmeansLab(oborder.map(rgbToLab), cutK).map((c) => c.center);
  const r = cutOutBackground(base, {
    colors: Math.max(1, Math.min(6, bgCut | 0)),
    centers: bgCenters,
    // --bg-cut-th 单独控制抠图容差，和后面压平背景的 --bg-threshold 分开
    threshold: num(args['bg-cut-th'], num(args['bg-threshold'], 26)),
    maxDepth: num(args['bg-cut-depth'], 0),
    // --bg-cut-keep x,y,w,h：人物包围盒（原图坐标），框内绝对不删。抠图最可靠的用法：
    // 框外用大阈值把背景清干净，框内原样保留，脸和衬衫绝不会被误伤。
    keep: (() => {
      const kk = String(args['bg-cut-keep'] || '').split(',').map(Number);
      if (kk.length !== 4 || !kk.every(Number.isFinite)) return null;
      const ox = cropArg.length === 4 ? Math.round(cropArg[0]) : 0;
      const oy = cropArg.length === 4 ? Math.round(cropArg[1]) : 0;
      return { x: kk[0] - ox, y: kk[1] - oy, w: kk[2], h: kk[3] };
    })(),
    lightness: num(args['bg-outline-light'], 45),
    sat: num(args['bg-outline-sat'], 0.42),
  });
  console.log(`抠图: 背景 ${r.removed} / ${r.total} 像素已移除 (${((r.removed / r.total) * 100).toFixed(0)}%)`);
}

// 1) 裁切缩放到目标格数（buffer 用于给主体留白）
let src = base;
const big = Math.round(Math.max(W, H) * (1 + buffer * 2));
const mode = ResizeStrategy.BICUBIC_INTERPOLATION;

// --fit contain：等比缩放，短边补纯色，人物完整保留。
// 方形图纸遇到竖长人物时 cover 会把头顶和脚切掉（45x45 配 215x258 的人物图要切掉上下 16%），
// contain 补边就没有这个问题；--pad-color 指定补边色，默认取原图左上角像素（通常就是背景色）。
const fit = String(args.fit && args.fit !== true ? args.fit : 'cover');
if (fit === 'contain') {
  let pad;
  if (args['pad-color'] && args['pad-color'] !== true) {
    const [pr, pg, pb] = hexToRgb(String(args['pad-color']));
    pad = { r: pr, g: pg, b: pb, a: 0xffffffff };
  } else {
    pad = { r: base.bitmap.data[0], g: base.bitmap.data[1], b: base.bitmap.data[2], a: 0xffffffff };
  }

  // --pad-blank：把与画布边缘连通的白色像素标成透明，图纸上留空不放豆。
  // 方形图纸做竖长人物时补边能占掉近一半格子，全按白豆铺满既费豆又白占一种颜色。
  // 用「从边缘洪泛」而不是「所有白色」：眼白高光、白衬衫虽然也是白的，但被人物包在中间，
  // 洪泛不到，会完整保留 —— 那几格恰恰是五官清晰度的关键。
  const padBlank = !!args['pad-blank'];
  src = src.clone().contain({ w: W, h: H, mode, color: pad });
  if (padBlank) {
    const n = W * H;
    const dd = src.bitmap.data;
    const vis = new Uint8Array(n);
    const q = new Int32Array(n);
    let head = 0;
    let tail = 0;
    const thr = Math.max(0, Math.min(64, num(args['pad-blank-tol'], 10)));
    const push = (i) => {
      if (vis[i] || i < 0 || i >= n) return;
      const o = i * 4;
      if (dd[o] < 255 - thr || dd[o + 1] < 255 - thr || dd[o + 2] < 255 - thr) return;
      vis[i] = 1;
      q[tail++] = i;
    };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (head < tail) {
      const i = q[head++];
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    for (let i = 0; i < n; i++) if (vis[i]) dd[i * 4 + 3] = 0;
    console.log(`留空: ${tail} 格不放豆（占 ${((tail / n) * 100).toFixed(0)}%）`);
  }
} else if (buffer > 0 && big !== Math.max(W, H)) {
  src = src.clone().cover({ w: big, h: big, mode });
  src = src.crop({ x: Math.round((src.bitmap.width - W) / 2), y: Math.round((src.bitmap.height - H) / 2), w: W, h: H });
} else {
  src = src.clone().cover({ w: W, h: H, mode });
}

// 1.5) 锐化：缩放会把睫毛、瞳孔这类细线插值成灰边，锐化能把边界重新拉干脆，
// 让小尺寸下的五官保持清晰（对"眼睛不糊"很关键）
const sharpenAmt = Math.max(0, Math.min(1.5, num(args.sharpen, 0)));
if (sharpenAmt > 0) {
  const k = sharpenAmt;
  const cw = src.bitmap.width;
  const chh = src.bitmap.height;
  const s = src.bitmap.data;
  const src8 = Buffer.from(s);
  const mid = 1 + 4 * k;
  for (let y = 1; y < chh - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const i = (y * cw + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = src8[i + ch] * mid - k * (src8[i - 4 + ch] + src8[i + 4 + ch]
          + src8[i - cw * 4 + ch] + src8[i + cw * 4 + ch]);
        s[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
}

const adj = {
  brightness: num(args.brightness, 0),
  contrast: num(args.contrast, 0),
  saturation: num(args.saturation, 1),
};

// 2) 采样 + 调色
const { data } = src.bitmap;
const samples = [];
const rgbOf = new Array(W * H).fill(null);
for (let i = 0; i < W * H; i++) {
  const o = i * 4;
  if (data[o + 3] < 128) continue;
  const c = adjust([data[o], data[o + 1], data[o + 2]], adj);
  rgbOf[i] = c;
  samples.push(rgbToLab(c));
}
if (samples.length === 0) {
  console.error('图片全透明，没有可用像素');
  process.exit(1);
}

// 3) k-means 选出代表性色号（不超过 maxColors 种）
const k = Math.min(maxColors, samples.length);
const clusters = kmeansLab(samples, k);
const paletteLabs = palette.colors.map((c) => rgbToLab(hexToRgb(c.hex)));

const candidateIdx = [];   // 候选色卡下标，顺序去重
clusters.forEach((cl) => {
  let best = 0, bd = Infinity;
  paletteLabs.forEach((lab, pi) => {
    const d = deltaE(cl.center, lab);
    if (d < bd) { bd = d; best = pi; }
  });
  if (!candidateIdx.includes(best)) candidateIdx.push(best);
});
const candidateLabs = candidateIdx.map((pi) => paletteLabs[pi]);

// 4) 每个像素只在候选色号内做 Lab 匹配（保证不会产生未分配的空格）
let grid = new Int16Array(W * H).fill(-1);
for (let i = 0; i < W * H; i++) {
  if (!rgbOf[i]) continue;
  const lab = rgbToLab(rgbOf[i]);
  let best = 0, bd = Infinity;
  candidateLabs.forEach((lab2, ci) => {
    const d = deltaE(lab, lab2);
    if (d < bd) { bd = d; best = ci; }
  });
  grid[i] = best;
}
let colors = candidateIdx.map((pi) => ({ ...palette.colors[pi], label: '' }));

// 按实际用量重排编号，图例里主色排前面
function reorder(gridIn, colorsIn) {
  const cnt = countColors(gridIn, colorsIn.length);
  const order = colorsIn.map((c, i) => i)
    .filter((i) => cnt[i] > 0)
    .sort((a, b) => cnt[b] - cnt[a] || colorsIn[a].code.localeCompare(colorsIn[b].code));
  const remap = new Int32Array(colorsIn.length).fill(-1);
  order.forEach((from, to) => { remap[from] = to; });
  const g = new Int16Array(gridIn.length);
  for (let i = 0; i < gridIn.length; i++) g[i] = gridIn[i] < 0 ? -1 : remap[gridIn[i]];
  const cs = order.map((from, to) => ({ ...colorsIn[from], label: String(to + 1).padStart(2, '0') }));
  return { grid: g, colors: cs };
}

// 5) 碎点清理 + 稀有色合并
// --bg auto：把从边缘连通的背景压平成纯色（--bg-colors 指定背景有几种主色）
if (args.bg && args.bg !== true && args.bg !== 'off') {
  // 背景取样用最外若干环，避免最外一圈的深色描边污染背景色
  const ring = Math.max(1, Math.min(4, num(args['bg-ring'], 2)));
  const border = [];
  for (let x = 0; x < W; x++) {
    for (let r = 0; r < ring; r++) {
      border.push(rgbOf[r * W + x], rgbOf[(H - 1 - r) * W + x]);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let r = 0; r < ring; r++) {
      border.push(rgbOf[y * W + r], rgbOf[y * W + (W - 1 - r)]);
    }
  }
  const borderLabs = border.filter(Boolean).map(rgbToLab);
  if (borderLabs.length) {
    // 背景色从完整色卡里挑最接近的（而不是只在量化候选里挑），避免背景被吸附成肤色
    const bgK = Math.max(1, Math.min(6, num(args['bg-colors'], 3)));
    const bgTargets = kmeansLab(borderLabs, bgK).map((c) => {
      let best = 0, bd = Infinity;
      paletteLabs.forEach((lab, pi) => {
        const d = deltaE(c.center, lab);
        if (d < bd) { bd = d; best = pi; }
      });
      let ci = candidateIdx.indexOf(best);
      if (ci < 0) {
        ci = candidateIdx.length;
        candidateIdx.push(best);
        candidateLabs.push(paletteLabs[best]);
      }
      return ci;
    });
    grid = flattenBackground(grid, W, H, candidateLabs, borderLabs, {
      bgTargets,
      threshold: num(args['bg-threshold'], 20),
      mode: args['bg-mode'] === 'flood' ? 'flood' : 'global',
      blank: !!args['bg-blank'],
      // --bg-outline：勾线当边界，背景水流穿不过去，脸/衬衫不会被误删
      outline: args['bg-outline'] ? findOutlineMask(rgbOf, W, H, {
        lightness: num(args['bg-outline-light'], 45),
        sat: num(args['bg-outline-sat'], 0.42),
      }) : null,
    });
    colors = candidateIdx.map((pi) => ({ ...palette.colors[pi], label: '' }));
    console.log(`背景 ${bgK} 簇: ${bgTargets.map((t) => palette.colors[candidateIdx[t]].code).join(' ')}  -> 候选共 ${candidateIdx.length} 色, 留空 ${args['bg-blank'] ? '是' : '否'}`);
  }
}

if (despeckleLevel > 0) grid = despeckle(grid, W, H, despeckleLevel);

// 5.5) --bg-box x,y,w,h（原图绝对坐标）：只有这个矩形算"人物"，框外整片当背景。
// 比按颜色自动分割可靠得多 —— 背景和主体同色（橙色耳机 / 橙色发带）时自动分割必然出错。
if (args['bg-box']) {
  const b = String(args['bg-box']).split(',').map(Number);
  if (b.length === 4 && b.every(Number.isFinite)) {
    const [bx, by, bw, bh] = b;
    const ox = cropArg.length === 4 ? Math.round(cropArg[0]) : 0;
    const oy = cropArg.length === 4 ? Math.round(cropArg[1]) : 0;
    const fill = args['bg-fill'] && args['bg-fill'] !== true ? String(args['bg-fill']) : null;
    let fillIdx = -1;
    if (fill) {
      const rgb = fill.startsWith('#') ? hexToRgb(fill) : null;
      const lab = rgbToLab(rgb || [128, 128, 128]);
      let bd = Infinity;
      paletteLabs.forEach((pl, pi) => { const dd = deltaE(lab, pl); if (dd < bd) { bd = dd; fillIdx = pi; } });
      let ci = candidateIdx.indexOf(fillIdx);
      if (ci < 0) { ci = candidateIdx.length; candidateIdx.push(fillIdx); candidateLabs.push(paletteLabs[fillIdx]); }
    }
    for (let i = 0; i < W * H; i++) {
      if (grid[i] < 0) continue;
      const px = (i % W) * (base.bitmap.width / W) + ox;
      const py = ((i - (i % W)) / W) * (base.bitmap.height / H) + oy;
      if (px < bx || py < by || px >= bx + bw || py >= by + bh) grid[i] = fillIdx;
    }
    colors = candidateIdx.map((pi) => ({ ...palette.colors[pi], label: '' }));
    console.log(`人物包围盒: ${b.join(',')}  框外${fillIdx < 0 ? '留空(不放豆)' : '填 ' + fill}`);
  }
}
if (minCount > 1) {
  grid = dropRare(grid, W, H, colors, minCount);
  const used = new Set([...new Set([...grid].filter((v) => v >= 0))]);
  const keep = colors.map((c, i) => i).filter((i) => used.has(i));
  const remap = new Int32Array(colors.length).fill(-1);
  keep.forEach((from, to) => { remap[from] = to; });
  const g2 = new Int16Array(grid.length);
  for (let i = 0; i < grid.length; i++) g2[i] = grid[i] < 0 ? -1 : remap[grid[i]];
  grid = g2;
  colors = keep.map((from, to) => ({ ...colors[from], label: String(to + 1).padStart(2, '0') }));
}

({ grid, colors } = reorder(grid, colors));

if (colors.length === 0) {
  console.error('没有生成任何颜色，检查 --min-count / --max-colors 参数');
  process.exit(1);
}

const counts = countColors(grid, colors.length);
const total = counts.reduce((a, b) => a + b, 0);
const outDir = path.resolve(process.cwd(), String(args.out || 'out'));
fs.mkdirSync(outDir, { recursive: true });

const title = String(args.title && args.title !== true ? args.title : path.basename(inputPath, path.extname(inputPath)));
const cellMm = Math.max(1, Math.min(10, num(args['cell-mm'], 5)));
const summary = `${W} x ${H} 格 | ${cellMm}mm 豆成品约 ${(W * cellMm / 10).toFixed(1)} x ${(H * cellMm / 10).toFixed(1)} cm | 共 ${total} 颗 | ${colors.filter((c, i) => counts[i] > 0).length} 种颜色 | 色卡: ${palette.name}`;

const legendSvg = args.legend === false ? null : renderLegendSvg({ colors, counts, opts });
const svg = renderSvg({ grid, W, H, colors, counts, opts });

fs.writeFileSync(path.join(outDir, 'pattern-a4.html'), renderHtml({ svg, legendSvg, meta: { title, summary, mode: opts.mode } }), 'utf8');
fs.writeFileSync(path.join(outDir, 'pattern.svg'), svg, 'utf8');
fs.writeFileSync(path.join(outDir, 'chart.txt'), '\ufeff' + renderChart({ grid, W, H, colors, counts, meta: { title, summary } }), 'utf8');
fs.writeFileSync(path.join(outDir, 'colors.csv'), '\ufeff' + renderCsv({ colors, counts }), 'utf8');
fs.writeFileSync(path.join(outDir, 'pattern.json'), JSON.stringify({
  title, width: W, height: H, beadMm: cellMm, palette: palette.name,
  grid: Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (grid[y * W + x] < 0 ? null : colors[grid[y * W + x]].code))),
  colors: colors.map((c, i) => ({ code: c.code, name: c.name, hex: c.hex, count: counts[i] })),
}, null, 2), 'utf8');
await renderPreviewPng({ grid, W, H, colors, scale, file: path.join(outDir, 'preview.png') });

console.log(`完成 -> ${outDir}`);
console.log(summary);
console.log(`模式: ${opts.mode}${opts.shape === 'square' ? '(方块)' : '(圆形)'}  |  去碎点: ${despeckleLevel}  |  去稀疏色阈值: ${minCount || '关'}`);
const rare = colors.map((c, i) => [c, counts[i]]).filter(([, n]) => n > 0 && n <= 2);
if (rare.length) console.log(`提示: ${rare.length} 个颜色只有 1~2 颗，建议 --min-count 3 并入相近色，省得单独买`);
if (W > 29 || H > 29) console.log('提示: 该尺寸超出单块 29x29 拼板，需要多块板拼接，拼接缝尽量放在图案边缘');