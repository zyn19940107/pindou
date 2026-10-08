// 诊断：查看某些格子采样到的像素分布（区分「格子底色」和「格内黑色色号文字」）
import { Jimp } from 'jimp';

const [file, geomArg] = process.argv.slice(2);
const [x0, y0, tx, ty] = geomArg.split(',').map(Number);
const img = await Jimp.read(file);
const { width: W, height: H, data } = img.bitmap;
const rgbAt = (x, y) => {
  const o = (y * W + x) * 4;
  return [data[o], data[o + 1], data[o + 2]];
};

function cellsOf(c, r, frac = 0.34) {
  const cx = x0 + tx * 0.5 + c * tx;
  const cy = y0 + ty * 0.5 + r * ty;
  const list = [];
  for (let dy = -ty * frac; dy <= ty * frac + 1e-6; dy += 0.4) {
    for (let dx = -tx * frac; dx <= tx * frac + 1e-6; dx += 0.4) {
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x >= 0 && y >= 0 && x < W && y < H) list.push([x, y, rgbAt(x, y)]);
    }
  }
  return list;
}
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// 1) 背景区亮度直方图
const hist = new Array(26).fill(0);
const all = [];
for (let r = 1; r <= 6; r++) {
  for (let c = 1; c <= 12; c++) {
    for (const [x, y, p] of cellsOf(c, r)) { hist[Math.min(25, Math.floor(lum(p) / 10))]++; all.push(lum(p)); }
  }
}
all.sort((a, b) => a - b);
console.log(`背景区采样 ${all.length} 像素`);
console.log('亮度直方图 (每10一级):');
hist.forEach((v, i) => { if (v) console.log(`  ${String(i * 10).padStart(3)}-${i * 10 + 9}: ${'#'.repeat(Math.round(v / Math.max(...hist) * 60))} ${v}`); });
console.log(`分位数: p10=${all[Math.floor(all.length * 0.1)].toFixed(0)} p25=${all[Math.floor(all.length * 0.25)].toFixed(0)} p50=${all[Math.floor(all.length * 0.5)].toFixed(0)} p75=${all[Math.floor(all.length * 0.75)].toFixed(0)} p90=${all[Math.floor(all.length * 0.9)].toFixed(0)}`);

// 2) 逐格列出几个背景格的中值
console.log('\n逐格中值（背景区）:');
for (let r = 1; r <= 4; r++) {
  const row = [];
  for (let c = 1; c <= 12; c++) {
    const list = cellsOf(c, r);
    const ch = [0, 1, 2].map((k) => {
      const v = list.map((p) => p[2][k]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    });
    row.push(`(${ch.join(',')})`);
  }
  console.log(`  r${r}: ${row.join(' ')}`);
}

// 3) 单格像素明细
console.log('\n单格像素明细 r=2,c=2:');
cellsOf(2, 2).forEach(([x, y, p]) => process.stdout.write(`(${x},${y})=${p.join(',')} `));
console.log('');