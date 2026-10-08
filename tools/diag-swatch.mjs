// 诊断：打印材料清单色块区域的列剖面与自相关
import { Jimp } from 'jimp';

const [file, y0s, y1s] = process.argv.slice(2);
const Y0 = +y0s;
const Y1 = +y1s;
const img = await Jimp.read(file);
const { width: W, height: H, data } = img.bitmap;
const rgbAt = (x, y) => {
  const o = (y * W + x) * 4;
  return [data[o], data[o + 1], data[o + 2]];
};

// 非白度剖面
const nw = new Float32Array(W);
for (let x = 0; x < W; x++) {
  let s = 0;
  for (let y = Y0; y <= Y1; y++) {
    const c = rgbAt(x, y);
    s += Math.max(255 - c[0], 255 - c[1], 255 - c[2]);
  }
  nw[x] = s / (Y1 - Y0 + 1);
}
// 每列中值颜色的相邻差异
const med = [];
for (let x = 0; x < W; x++) {
  const list = [];
  for (let y = Y0; y <= Y1; y++) list.push(rgbAt(x, y));
  const ch = [0, 1, 2].map((c) => {
    const v = list.map((p) => p[c]).sort((u, v) => u - v);
    return v[Math.floor(v.length / 2)];
  });
  med.push(ch);
}
const dlab = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const diff = new Float32Array(W);
for (let x = 1; x < W - 1; x++) diff[x] = dlab(med[x - 1], med[x + 1]);

const spark = (arr, label, lo = 0, hi = W, w = 6) => {
  const sub = arr.slice(lo, hi);
  const max = Math.max(...sub, 1);
  const chars = ' .:-=+*#%@';
  let out = '';
  for (let i = 0; i < sub.length; i++) out += chars[Math.min(9, Math.floor((sub[i] / max) * 10))];
  console.log(`${label} (max=${max.toFixed(1)}) x=${lo}..${hi}`);
  for (let i = 0; i < out.length; i += w) console.log(`  x=${String(lo + i).padStart(3)} |${out.slice(i, i + w)}|`);
};
spark(nw, '非白度');
spark(diff, '列间色差');

// 自相关（去均值，归一化）
function acf(arr, lo, hi) {
  const seg = [];
  for (let i = lo; i < hi; i++) seg.push(arr[i]);
  const m = seg.reduce((a, b) => a + b, 0) / seg.length;
  const out = [];
  for (let lag = 5; lag <= 20; lag++) {
    let s = 0;
    let n = 0;
    for (let i = lag; i < seg.length; i++) { s += (seg[i] - m) * (seg[i - lag] - m); n++; }
    out.push([lag, s / n]);
  }
  return out;
}
const showAcf = (name, arr) => {
  const a = acf(arr, 0, W);
  const mx = Math.max(...a.map((v) => Math.abs(v[1]))) || 1;
  console.log(`\n${name} 自相关:`);
  a.forEach(([lag, v]) => console.log(`  ${String(lag).padStart(2)}px ${(v / mx).toFixed(3)} ${'#'.repeat(Math.max(0, Math.round((v / mx) * 60)))}`));
};
showAcf('非白度', nw);
showAcf('列间色差', diff);