// 叠加校验：按给定几何在照片上画网格线（红色），放大后目视是否贴合
import { Jimp } from 'jimp';

const [file, geomArg, colsS, rowsS, oxS, oyS, owS, ohS] = process.argv.slice(2);
const [x0, y0, tx, ty] = geomArg.split(',').map(Number);
const cols = +colsS;
const rows = +rowsS;
const OX = +oxS;
const OY = +oyS;
const OW = +owS;
const OH = +ohS;
const Z = 4;

const img = await Jimp.read(file);
const crop = img.crop({ x: OX, y: OY, w: OW, h: OH }).scale(Z, Z);
const b = crop.bitmap;
const OWp = b.width;
const OHp = b.height;
const mark = (x, y, r, g, bl) => {
  if (x < 0 || y < 0 || x >= OWp || y >= OHp) return;
  const o = (y * OWp + x) * 4;
  b.data[o] = r; b.data[o + 1] = g; b.data[o + 2] = bl;
};
for (let c = 0; c <= cols; c++) {
  const px = Math.round((x0 - OX + c * tx) * Z);
  if (c % 5 !== 0 && c !== 0 && c !== cols) continue;
  for (let y = 0; y < OHp; y++) mark(px, y, 255, 0, 0);
}
for (let r = 0; r <= rows; r++) {
  const py = Math.round((y0 - OY + r * ty) * Z);
  if (r % 5 !== 0 && r !== 0 && r !== rows) continue;
  for (let x = 0; x < OWp; x++) mark(x, py, 255, 0, 0);
}
await crop.write('out/diag-overlay.png');
console.log(`-> out/diag-overlay.png (${OWp}x${OHp})`);