// 生成一张测试图（渐变背景 + 同心圆环 + 色块），用于验证图纸管线
import { Jimp } from 'jimp';

const S = 420;
const img = new Jimp({ width: S, height: S, color: 0xffffff });
const { bitmap } = img;

const set = (x, y, hex) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const n = parseInt(hex.slice(1), 16);
  const o = (y * S + x) * 4;
  bitmap.data[o] = (n >> 16) & 255;
  bitmap.data[o + 1] = (n >> 8) & 255;
  bitmap.data[o + 2] = n & 255;
  bitmap.data[o + 3] = 255;
};

// 垂直渐变背景（模拟照片）
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const hex = `#${[Math.round(120 + 100 * t), Math.round(190 - 60 * t), Math.round(230 - 40 * t)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  for (let x = 0; x < S; x++) set(x, y, hex);
}

const cx = S / 2, cy = S / 2;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > 150 && d <= 195) set(x, y, '#F2C94C');
    else if (d > 100 && d <= 150) set(x, y, '#E8703A');
    else if (d <= 100) set(x, y, '#3B7DD8');
    if (d > 178 && d < 190) set(x, y, '#7A4A2E');
  }
}
await img.write('test/sample.png');
console.log('测试图已生成: test/sample.png');