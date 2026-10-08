// 色卡加载：内置 midi / generic，或用户自备的 JSON / CSV
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return `#${[v, v, v].map((c) => c.toString(16).padStart(2, '0')).join('')}`; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${to(hue(h + 1 / 3))}${to(hue(h))}${to(hue(h - 1 / 3))}`;
}

// 无品牌色卡时的兜底：色相均匀 + 明度分档，屏幕观感最讨喜
function makeGeneric() {
  const hues = [
    ['红', 0], ['橙', 30], ['琥珀', 42], ['黄', 55], ['黄绿', 80], ['草绿', 110],
    ['绿', 140], ['青绿', 165], ['青', 185], ['天蓝', 205], ['蓝', 220], ['靛', 245],
    ['紫', 270], ['品红', 300], ['玫红', 330], ['粉', 350],
  ];
  const levels = [['深', 0.34, 0.72], ['中', 0.5, 0.85], ['亮', 0.66, 0.9], ['浅', 0.82, 0.55]];
  const colors = [];
  let n = 1;
  for (const [hueName, hue] of hues) {
    for (const [tag, l, s] of levels) {
      colors.push({ code: `G${String(n).padStart(2, '0')}`, name: `${tag}${hueName}`, hex: hslToHex(hue, s, l) });
      n++;
    }
  }
  return { name: '通用高饱和色卡（无品牌）', colors };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (line) => {
    const cells = [];
    let cur = '', inQuote = false;
    for (const ch of line) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = head.some((h) => /色号|code|name|名称|hex|rgb|r/.test(h));
  const rows = hasHeader ? lines.slice(1) : lines;
  const colors = [];
  for (const line of rows) {
    const c = split(line);
    if (c.length < 2) continue;
    const hex = c.find((v) => /^#?[0-9a-f]{6}$/i.test(v) || /^#?[0-9a-f]{3}$/i.test(v));
    let rgb = null;
    if (!hex) {
      const nums = c.map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v) && v >= 0 && v <= 255);
      if (nums.length >= 3) rgb = nums.slice(0, 3);
    }
    if (!hex && !rgb) continue;
    const value = hex ? (hex.startsWith('#') ? hex : `#${hex}`) : rgbToHex(rgb);
    const code = (c.find((v) => /^[A-Za-z]{1,2}\s?\d{1,3}$/.test(v)) || c[0]).trim();
    const name = (c.find((v) => v !== code && v !== value) || '').trim();
    colors.push({ code, name, hex: value });
  }
  return colors;
}

function rgbToHex([r, g, b]) {
  const to = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function loadPalette(spec = 'midi', override = '') {
  let palette;
  if (spec === 'generic') {
    palette = makeGeneric();
  } else if (spec === 'midi' || !spec) {
    palette = JSON.parse(fs.readFileSync(path.join(ROOT, 'palettes', 'midi.json'), 'utf8'));
  } else {
    const file = path.resolve(process.cwd(), spec);
    if (!fs.existsSync(file)) throw new Error(`色卡文件不存在: ${file}`);
    if (/\.json$/i.test(file)) palette = JSON.parse(fs.readFileSync(file, 'utf8'));
    else palette = { name: path.basename(file), colors: parseCsv(fs.readFileSync(file, 'utf8')) };
    if (Array.isArray(palette)) palette = { name: '自定义色卡', colors: palette };
  }

  // 覆盖校正：--override "H01=#FF0000;C01=#00FF00"
  if (override) {
    for (const pair of String(override).split(';')) {
      const [code, hex] = pair.split(':');
      if (!code || !hex) continue;
      const value = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
      const target = palette.colors.find((c) => c.code.toLowerCase() === code.trim().toLowerCase());
      if (target) target.hex = value;
      else palette.colors.push({ code: code.trim(), name: '自定义', hex: value });
    }
  }

  const seen = new Set();
  const bad = [];
  palette.colors = palette.colors.filter((c) => {
    if (!/^#[0-9a-f]{6}$/i.test(c.hex)) { bad.push(`${c.code}=${c.hex}`); return false; }
    const k = c.code.toUpperCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (bad.length) console.warn(`色卡中 ${bad.length} 个色值格式非法已忽略: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' ...' : ''}`);
  if (!palette.colors.length) throw new Error('色卡里没有可用颜色');
  return palette;
}