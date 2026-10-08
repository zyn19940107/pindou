// analyze.mjs 的自检：对一张图跑完四项能力并打印结论，
// 顺带验证「原图眼宽 -> 目标格数下几格宽」这个换算和肉眼判断是否一致。
// 用法：node test/analyze.mjs [图片] [格数] [debug]
import { detectSubjectBBox, detectEyeMetrics, evaluateEyeCells, evaluateFit, suggestEyeCrop, filterPaletteByHue, HUE_PRESETS } from '../lib/analyze.mjs';
import { loadPalette } from '../lib/palette.mjs';

const [, , input = 'input/image.png', gridArg = '45', debugArg] = process.argv;
const gridSize = Number(gridArg);

const t0 = Date.now();
const box = await detectSubjectBBox(input);
console.log(`[主体bbox] ${box.found ? `x:${box.bbox.x} y:${box.bbox.y} w:${box.bbox.w} h:${box.bbox.h}` : '未找到(纯色图)'}`);
console.log(`           建议裁剪 ${box.crop.x},${box.crop.y},${box.crop.w},${box.crop.h}   背景 rgb(${box.bgColor})  占比 ${box.coverage ?? '-'}  原图 ${box.imageW}x${box.imageH}`);

const eye = await detectEyeMetrics(input, { debug: debugArg === 'debug' });
if (!eye.found) {
  console.log(`[眼部] 未检出：${eye.reason}`);
} else {
  console.log(`[眼部] 眼宽 ${eye.eyePx}px(保守 ${eye.eyePxMin})  眼高 ${eye.eyeHeightPx}px  眼线 y=${eye.eyeLineY}  左右 ${eye.leftW}/${eye.rightW}px  间距 ${eye.gapPx}px  环绕对比 ${eye.contrast}  中心比 ${eye.cxRatio}  候选暗块 ${eye.candidates}  置信 ${eye.confidence}`);
  console.log(`       双眼包围盒 ${JSON.stringify(eye.box)}`);
  if (eye.note) console.log(`       提示：${eye.note}`);
  const judge = (cw) => {
    const r = evaluateEyeCells(eye.eyePx, cw, gridSize);
    const rMin = evaluateEyeCells(eye.eyePxMin, cw, gridSize);
    return `${cw}px裁框 -> ${r.cells}格[${r.level}] / 保守 ${rMin.cells}格[${rMin.level}]  ${r.advice}`;
  };
  console.log(`[清晰度] ${judge(box.crop.w)}`);
  console.log(`         ${judge(Math.round(box.crop.w * 0.7))}`);
  const r8 = evaluateEyeCells(eye.eyePx, box.crop.w, gridSize);
  console.log(`         想达 8 格需把画面裁到 ${r8.cropWidthFor.eight}px 宽；5 格需 ${r8.cropWidthFor.five}px 宽`);
  for (const target of [8, 10, 12]) {
    const s = suggestEyeCrop(eye, gridSize, target);
    console.log(`[裁剪框] 目标 ${target} 格眼宽 -> --crop ${s.crop}${s.clamped ? ' (已夹到画面内)' : ''}  实得 ${s.cells} 格`);
  }
}

const fit = evaluateFit(box.imageW, box.imageH, gridSize);
console.log(`[构图] 比例 ${fit.ratio}  cover 满格 ${fit.coverGrids}  短边仅 ${fit.shortSideGrids}格  contain 浪费 ${fit.wastedGrids}颗`);
console.log(`       ${fit.advice}`);

const pal = loadPalette('midi', '');
for (const [key, preset] of Object.entries(HUE_PRESETS)) {
  const f = filterPaletteByHue(pal, preset.ranges, preset.name);
  console.log(`[色卡] ${key.padEnd(8)} ${f.colors.length} 色（剔除 ${f.dropped.length}） ${f.dropped.map((c) => c.code).join(' ') || '-'}`);
}

console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
