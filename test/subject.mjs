// 单独跑人物分割，方便调参：把人物抠出来、背景换成纯色，并自动裁到人物外接框。
import { segmentSubject, compositeOnColor } from '../lib/subject.mjs';

const [, , input = 'input/image.png', model = 'models/u2net.onnx', out = 'out/_subject.png', bg = '#FFFFFF'] = process.argv;

const env = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const t = Date.now();
const seg = await segmentSubject(input, model, {
  size: env('SUBJ_SIZE', 320),
  stretch: process.env.SUBJ_STRETCH !== '0',
  alphaFloor: env('SUBJ_FLOOR', 0.4),
  closeR: env('SUBJ_CLOSE', 8),
  grow: env('SUBJ_GROW', 26),
  vividSat: env('SUBJ_VIVID', 0.32),
  darkL: env('SUBJ_DARK', 44),
  expandR: env('SUBJ_EXPAND', 2),
  openR: env('SUBJ_OPEN', 6),
  keepLargest: process.env.SUBJ_LARGEST !== '0',
  fillInner: process.env.SUBJ_FILL !== '0',
});
const r = await compositeOnColor(input, seg, out, bg, { pad: env('SUBJ_PAD', 0.03) });
console.log(`分割 ${seg.width}x${seg.height}  人物占比 ${(seg.coverage * 100).toFixed(1)}%  耗时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log(`输出 -> ${out}  ${r.width}x${r.height} (比例 ${(r.width / r.height).toFixed(3)})  背景 ${bg}`);