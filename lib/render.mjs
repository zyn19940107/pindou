// 输出渲染：矢量图纸 / A4 打印页 / PNG 预览 / 数字表格 / 用量清单
import { Jimp } from 'jimp';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE_W = 194;   // A4 减去页边距后的可用宽度 mm
const MARGIN_L = 9;   // 左侧行号
const MARGIN_R = 4;   // 右侧留白
const MARGIN_T = 7;   // 顶部列号
const BLOCK = 5;      // 每 5 格细分区
const MAJOR = 15;     // 每 15 格粗分区

export function renderSvg({ grid, W, H, colors, counts, opts }) {
  const cell = Math.min(6, Math.max(2.2, (PAGE_W - MARGIN_L - MARGIN_R) / W));
  const gw = W * cell, gh = H * cell;
  const x0 = MARGIN_L, y0 = MARGIN_T;
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${gw + x0 + 4}mm" height="${gh + y0 + 4}mm" viewBox="0 0 ${gw + x0 + 4} ${gh + y0 + 4}">`);
  parts.push(`<rect x="0" y="0" width="${gw + x0 + 4}" height="${gh + y0 + 4}" fill="#fff"/>`);

  // 坐标：列号（每格）与行号（每格），N<=45 时全部标出
  const axisFont = Math.max(1.5, Math.min(2.6, cell * 0.5));
  for (let x = 0; x < W; x++) {
    const major = (x + 1) % MAJOR === 0;
    if (cell < 3 && !major && (x + 1) % BLOCK !== 0) continue;
    parts.push(`<text x="${x0 + x * cell + cell / 2}" y="${y0 - 1.6}" font-size="${axisFont}" text-anchor="middle" fill="#333" font-family="sans-serif">${x + 1}</text>`);
  }
  for (let y = 0; y < H; y++) {
    const major = (y + 1) % MAJOR === 0;
    if (cell < 3 && !major && (y + 1) % BLOCK !== 0) continue;
    parts.push(`<text x="${x0 - 1.4}" y="${y0 + y * cell + cell / 2 + axisFont * 0.35}" font-size="${axisFont}" text-anchor="end" fill="#333" font-family="sans-serif">${y + 1}</text>`);
  }

  // 珠子
  const r = cell * 0.42;
  const showLabel = opts.mode === 'mono' || opts.labels;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ci = grid[y * W + x];
      if (ci < 0) continue;
      const c = colors[ci];
      const cx = x0 + x * cell + cell / 2, cy = y0 + y * cell + cell / 2;
      if (opts.shape === 'square') {
        parts.push(`<rect x="${x0 + x * cell + cell * 0.08}" y="${y0 + y * cell + cell * 0.08}" width="${cell * 0.84}" height="${cell * 0.84}" fill="${c.hex}" stroke="#222" stroke-width="0.15"/>`);
      } else {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.hex}" stroke="#222" stroke-width="0.15"/>`);
      }
      if (showLabel) {
        const dark = isDark(c.hex);
        parts.push(`<text x="${cx}" y="${cy + cell * 0.16}" font-size="${cell * 0.5}" text-anchor="middle" fill="${dark ? '#fff' : '#111'}" font-family="sans-serif" font-weight="bold">${c.label}</text>`);
      }
    }
  }

  // 分区线
  for (let x = 0; x <= W; x++) {
    const major = x % MAJOR === 0, minor = x % BLOCK === 0;
    if (!major && !minor && x !== W && x !== 0) continue;
    parts.push(`<line x1="${x0 + x * cell}" y1="${y0}" x2="${x0 + x * cell}" y2="${y0 + gh}" stroke="${major ? '#000' : '#bbb'}" stroke-width="${major ? 0.3 : 0.12}"/>`);
  }
  for (let y = 0; y <= H; y++) {
    const major = y % MAJOR === 0, minor = y % BLOCK === 0;
    if (!major && !minor && y !== H && y !== 0) continue;
    parts.push(`<line x1="${x0}" y1="${y0 + y * cell}" x2="${x0 + gw}" y2="${y0 + y * cell}" stroke="${major ? '#000' : '#bbb'}" stroke-width="${major ? 0.3 : 0.12}"/>`);
  }
  parts.push(`<rect x="${x0}" y="${y0}" width="${gw}" height="${gh}" fill="none" stroke="#000" stroke-width="0.35"/>`);
  parts.push('</svg>');
  return parts.join('\n');
}

export function renderLegendSvg({ colors, counts, opts }) {
  const cols = 5;
  const itemW = PAGE_W / cols;
  const rowH = 4.4;
  const rows = Math.ceil(colors.length / cols);
  const w = PAGE_W, h = rows * rowH + 5;
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`);
  p.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>`);
  p.push(`<text x="0" y="3.2" font-size="3" font-weight="bold" fill="#111" font-family="sans-serif">色号图例（数字 = 图纸上的编号）</text>`);
  colors.forEach((c, i) => {
    const cx = (i % cols) * itemW;
    const cy = 6 + Math.floor(i / cols) * rowH;
    p.push(`<rect x="${cx}" y="${cy - 2.5}" width="3.2" height="3.2" fill="${c.hex}" stroke="#222" stroke-width="0.15"/>`);
    p.push(`<text x="${cx + 4.2}" y="${cy}" font-size="2.6" fill="#111" font-family="sans-serif">${esc(c.label)} ${esc(c.code)}${c.name ? ' ' + esc(c.name) : ''} x${counts[i]}</text>`);
    if (counts[i] > 0 && counts[i] <= 2) {
      p.push(`<text x="${cx + itemW - 3}" y="${cy}" font-size="2.4" fill="#c00" font-family="sans-serif">少</text>`);
    }
  });
  p.push('</svg>');
  return p.join('\n');
}

export function renderHtml({ svg, legendSvg, meta }) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(meta.title)} 拼豆图纸</title>
<style>
  @page { size: A4 portrait; margin: 10mm 8mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; margin: 0; padding: 14px; color: #111; background: #f5f5f5; }
  .sheet { width: 194mm; margin: 0 auto 12mm; padding: 0; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  .head { padding: 0 0 3mm; }
  .head h1 { font-size: 14pt; margin: 0 0 2px; }
  .head .meta { font-size: 8.5pt; color: #555; line-height: 1.6; }
  .head .tips { font-size: 8pt; color: #666; margin-top: 2px; }
  .legend { margin-top: 4mm; border-top: 1px dashed #bbb; padding-top: 2mm; page-break-inside: avoid; }
  .hint { max-width: 194mm; margin: 0 auto 14px; font-size: 13px; color: #555; line-height: 1.7; }
  .hint code { background: #eee; padding: 1px 5px; border-radius: 3px; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; margin: 0; width: auto; page-break-after: always; }
    .hint { display: none; }
  }
</style></head>
<body>
<div class="hint">打印设置：纸张 <code>A4</code>、缩放 <code>100%（不要"适应页面"）</code>、边距 <code>默认</code>、勾选 <code>背景图形</code>。
先按 <code>${meta.mode === 'mono' ? '图例编号' : '色卡'}</code> 分色拣豆，再从图纸中心或第一行开始拼。</div>
<div class="sheet">
  <div class="head">
    <h1>${esc(meta.title)}</h1>
    <div class="meta">${esc(meta.summary)}</div>
    <div class="tips">粗线每 ${MAJOR} 格一条，细则条每 ${BLOCK} 格一条；坐标从左上角 1 开始。</div>
  </div>
  ${svg}
  ${legendSvg ? `<div class="legend">${legendSvg}</div>` : ''}
</div>
</body></html>`;
}

// 屏幕预览图：纯色块 + 分区线，不含文字
export async function renderPreviewPng({ grid, W, H, colors, scale = 12, file }) {
  const pad = Math.round(scale / 2);
  const w = W * scale + pad * 2, h = H * scale + pad * 2;
  const img = new Jimp({ width: w, height: h, color: 0xffffff });
  const bmp = img.bitmap;
  const put = (x, y, hex) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const n = parseInt(hex.slice(1), 16);
    const o = (y * w + x) * 4;
    bmp.data[o] = (n >> 16) & 255;
    bmp.data[o + 1] = (n >> 8) & 255;
    bmp.data[o + 2] = n & 255;
    bmp.data[o + 3] = 255;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ci = grid[y * W + x];
      if (ci < 0) continue;
      const c = colors[ci];
      const x0 = pad + x * scale, y0 = pad + y * scale;
      const inset = 0;
      for (let yy = y0 + inset; yy < y0 + scale - inset; yy++) {
        for (let xx = x0 + inset; xx < x0 + scale - inset; xx++) put(xx, yy, c.hex);
      }
      if (x % BLOCK === 0 || y % BLOCK === 0) {
        for (let k = 0; k < scale; k++) {
          put(x0 + k, y0, '#c9c9c9');
          put(x0, y0 + k, '#c9c9c9');
        }
      }
      if (x % MAJOR === 0 || y % MAJOR === 0) {
        for (let k = 0; k < scale; k++) {
          put(x0 + k, y0, '#000000');
          put(x0, y0 + k, '#000000');
        }
      }
    }
  }
  await img.write(file);
}

export function renderChart({ grid, W, H, colors, counts, meta }) {
  const L = [];
  L.push(`# ${meta.title}`);
  L.push(`尺寸: ${W} x ${H} 格  |  5mm 豆成品约 ${(W * 0.5).toFixed(1)} x ${(H * 0.5).toFixed(1)} cm  |  总豆数 ${counts.reduce((a, b) => a + b, 0)} 颗  |  用色 ${counts.filter((c) => c > 0).length} 种`);
  L.push('');
  L.push('## 图例');
  for (let i = 0; i < colors.length; i++) {
    if (!counts[i]) continue;
    L.push(`  ${colors[i].label}  ${colors[i].code.padEnd(6)} ${(colors[i].name || '').padEnd(6, '　')} ${colors[i].hex}  ${String(counts[i]).padStart(4)} 颗${counts[i] <= 2 ? '   <- 颗数极少，可考虑并入相近色' : ''}`);
  }
  L.push('');
  L.push('## 图纸（左侧为行号，顶部数字为列号）');
  const head = '       ' + Array.from({ length: W }, (_, i) => String((i + 1) % 10)).join(' ');
  L.push(head);
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      const ci = grid[y * W + x];
      row.push(ci < 0 ? ' .' : ` ${colors[ci].label}`);
    }
    const sep = (y + 1) % MAJOR === 0 && y + 1 < H ? '  <= 每 ' + MAJOR + ' 格' : '';
    L.push(`  ${String(y + 1).padStart(2, ' ')} |${row.join('')}${sep}`);
  }
  return L.join('\n');
}

export function renderCsv({ colors, counts }) {
  const rows = ['色号,名称,HEX,颗数,建议采购(含5%)'];
  for (let i = 0; i < colors.length; i++) {
    if (!counts[i]) continue;
    rows.push(`${colors[i].code},${colors[i].name || ''},${colors[i].hex},${counts[i]},${Math.ceil(counts[i] * 1.05)}`);
  }
  return rows.join('\n');
}

function isDark(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.55;
}