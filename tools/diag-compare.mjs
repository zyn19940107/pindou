// 对比图：左边原照片裁剪，右边还原后的网格（相同尺寸），中间留白
import fs from 'node:fs';
import { Jimp } from 'jimp';

const [file, gridFile, geomArg, colsS, rowsS] = process.argv.slice(2);
const [x0, y0, tx, ty] = geomArg.split(',').map(Number);
const cols = +colsS;
const rows = +rowsS;
const Z = 5;

const img = await Jimp.read(file);
const left = img.crop({
  x: Math.round(x0), y: Math.round(y0),
  w: Math.round(cols * tx), h: Math.round(rows * ty),
}).scale(Z, Z);
const LW = left.bitmap.width;
const LH = left.bitmap.height;

const data = JSON.parse(fs.readFileSync(gridFile, 'utf8'));
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const right = new Jimp({ width: LW, height: LH, color: 0xffffff });
const rb = right.bitmap;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const code = data.grid[r][c];
    const entry = data.colors.find((x) => x.code === code) || { hex: '#ff00ff' };
    const [cr, cg, cb] = hex2rgb(entry.hex);
    const x0p = Math.round((c * LW) / cols);
    const x1p = Math.round(((c + 1) * LW) / cols);
    const y0p = Math.round((r * LH) / rows);
    const y1p = Math.round(((r + 1) * LH) / rows);
    for (let yy = y0p; yy < y1p; yy++) {
      for (let xx = x0p; xx < x1p; xx++) {
        const o = (yy * LW + xx) * 4;
        rb.data[o] = cr; rb.data[o + 1] = cg; rb.data[o + 2] = cb; rb.data[o + 3] = 255;
      }
    }
  }
}

const gap = 24;
const out = new Jimp({ width: LW * 2 + gap, height: LH, color: 0x101010 });
out.composite(left, 0, 0);
out.composite(right, LW + gap, 0);
await out.write('out/compare.png');
console.log(`-> out/compare.png (${LW * 2 + gap}x${LH})  左=照片 右=还原`);
void rows; void ty; void y0;