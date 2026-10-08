// 人物主体分割：用 U2-Net（onnxruntime-node 直接推理）抠出人物，背景换成纯色。
//
// 为什么自己跑推理而不用 @imgly/background-removal-node：
// 那个包装库在 Node 24 下 ndarray 的 CJS interop 会崩（imageTensor.shape 为 undefined）。
// 直接用 onnxruntime-node 反而更可控，预处理/后处理都能按漫画图调。
//
// 预处理严格对齐训练时的 U2-Net 设置：320x320 cubic resize + ImageNet 归一化，
// 输出用 (p-min)/(max-min) 拉伸后再软化 alpha。
import { createRequire } from 'node:module';
import { rgbToLab, deltaE, kmeansLab } from './color.mjs';

const require = createRequire(import.meta.url);

/* ---------------------------- 二值形态学工具 ---------------------------- */

// 方形结构元膨胀（横竖两遍可分离实现，O(n·r)）
export function dilate(mask, W, H, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < W && mask[row + xx]) { v = 1; break; }
      }
      tmp[row + x] = v;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < H && tmp[yy * W + x]) { v = 1; break; }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

export function erode(mask, W, H, r) {
  const d = dilate(mask, W, H, r);
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = d[i] ? 0 : 1;
  const e = dilate(inv, W, H, r);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = e[i] ? 0 : 1;
  return out;
}

// 先膨胀后腐蚀：补掉主体内部的空洞/断裂
export function close(mask, W, H, r) {
  return erode(dilate(mask, W, H, r), W, H, r);
}

// 先腐蚀后膨胀：去掉孤立噪点
export function open(mask, W, H, r) {
  return dilate(erode(mask, W, H, r), W, H, r);
}

export function largestComponent(mask, W, H) {
  const lab = new Int32Array(W * H).fill(-1);
  const stack = [];
  let best = -1;
  let bestSize = 0;
  let cur = 0;
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    cur++;
    let size = 0;
    stack.push(s);
    lab[s] = cur;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0 && mask[i - 1] && lab[i - 1] < 0) { lab[i - 1] = cur; stack.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && lab[i + 1] < 0) { lab[i + 1] = cur; stack.push(i + 1); }
      if (y > 0 && mask[i - W] && lab[i - W] < 0) { lab[i - W] = cur; stack.push(i - W); }
      if (y < H - 1 && mask[i + W] && lab[i + W] < 0) { lab[i + W] = cur; stack.push(i + W); }
    }
    if (size > bestSize) { bestSize = size; best = cur; }
  }
  const out = new Uint8Array(W * H);
  if (best > 0) for (let i = 0; i < W * H; i++) out[i] = lab[i] === best ? 1 : 0;
  return { mask: out, size: bestSize };
}

// 连通域面积过滤：保留面积 >= max(绝对下限, 最大块面积 * ratio) 的块，其余抹掉。
// largestComponent 只留最大的一块，但形态学的区域生长会把背景条纹重新粘到人物身上，
// 于是「人物 + 一堆小碎片」变成互相连通的一整块。只保留最大块救不了这种情况，
// 真正管用的是按面积门槛把碎片一块块剔掉 —— 人物的每个部位（脸、头发、衬衫）都远大于碎片。
export function filterComponents(mask, W, H, ratio = 0.06, absMin = 24) {
  const lab = new Int32Array(W * H).fill(-1);
  const stack = [];
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    const id = comps.length;
    const cells = [];
    stack.push(s);
    lab[s] = id;
    while (stack.length) {
      const i = stack.pop();
      cells.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (x > 0 && mask[i - 1] && lab[i - 1] < 0) { lab[i - 1] = id; stack.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && lab[i + 1] < 0) { lab[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && mask[i - W] && lab[i - W] < 0) { lab[i - W] = id; stack.push(i - W); }
      if (y < H - 1 && mask[i + W] && lab[i + W] < 0) { lab[i + W] = id; stack.push(i + W); }
    }
    comps.push(cells);
  }
  if (!comps.length) return mask;
  let maxSize = 0;
  for (const c of comps) if (c.length > maxSize) maxSize = c.length;
  const floor = Math.max(absMin, Math.round(maxSize * ratio));
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] ? 1 : 0;
  for (const c of comps) if (c.length < floor) for (const i of c) out[i] = 0;
  return out;
}

// 填掉主体内部的孔洞：从画布边界洪泛外部，洪泛不到的"空"就是被主体包住的洞。
// maxHole 为面积上限：只填小洞（衣服镂空、图案间隙），大面积的区域（被误包进来的背景块）保留成背景。
export function fillHoles(mask, W, H, maxHole = Infinity) {
  const out = Uint8Array.from(mask);
  const ext = new Uint8Array(W * H);
  const stack = [];
  const push = (i) => { if (out[i] || ext[i]) return; ext[i] = 1; stack.push(i); };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  // 未被外部洪泛覆盖的像素按连通分量分组，逐个判断面积
  const seen = new Uint8Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (ext[s] || out[s] || seen[s]) continue;
    const comp = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % W;
      const y = (i - x) / W;
      const add = (j) => { if (!seen[j] && !ext[j] && !out[j]) { seen[j] = 1; stack.push(j); } };
      if (x > 0) add(i - 1);
      if (x < W - 1) add(i + 1);
      if (y > 0) add(i - W);
      if (y < H - 1) add(i + W);
    }
    if (comp.length <= maxHole) for (const i of comp) out[i] = 1;
  }
  return out;
}

// 前景像素的"向内深度"：紧贴边界的为 1，往里递增。
// 用来区分「边缘污染」和「人物自身的深色/浅色」——头发、白衬衫深度都 > 1，不能误删。
export function depthFromBorder(mask, W, H) {
  const depth = new Int32Array(W * H).fill(0);
  const queue = [];
  const push = (i, d) => {
    if (depth[i]) return;
    const x = i % W;
    const y = (i - x) / W;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1
      || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W]) {
      depth[i] = 1;
      queue.push(i);
      return;
    }
    if (d > 0) { depth[i] = d; queue.push(i); }
  };
  for (let i = 0; i < W * H; i++) if (mask[i]) push(i, 0);
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % W;
    const y = (i - x) / W;
    const d = depth[i] + 1;
    if (x > 0) push(i - 1, d);
    if (x < W - 1) push(i + 1, d);
    if (y > 0) push(i - W, d);
    if (y < H - 1) push(i + W, d);
  }
  return depth;
}

// 从画面四周洪泛，标记出「与外部连通」的像素。
// 用来区分真背景和人物自身的颜色：橙发带/橙耳机被深色轮廓包住，不与外部连通，会被保留；
// 环绕人物、与外部橙色背景连成一片的橙条会被剔除。
export function floodFromBorder(mask, W, H) {
  const out = new Uint8Array(W * H);
  const stack = [];
  const push = (i) => { if (!mask[i] || out[i]) return; out[i] = 1; stack.push(i); };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i - x) / W;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  return out;
}

// 每个像素到最近「标记像素」的多源 BFS 距离
export function distanceFrom(mask, W, H) {
  const INF = 0x3fffffff;
  const dist = new Int32Array(W * H).fill(INF);
  const q = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < W * H; i++) if (mask[i]) { dist[i] = 0; q[tail++] = i; }
  while (head < tail) {
    const i = q[head++];
    const x = i % W;
    const y = (i - x) / W;
    const d = dist[i] + 1;
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; q[tail++] = i - 1; }
    if (x < W - 1 && dist[i + 1] > d) { dist[i + 1] = d; q[tail++] = i + 1; }
    if (y > 0 && dist[i - W] > d) { dist[i - W] = d; q[tail++] = i - W; }
    if (y < H - 1 && dist[i + W] > d) { dist[i + W] = d; q[tail++] = i + W; }
  }
  return dist;
}

// 3x3 中值滤波：去掉「部分变白、部分保留」造成的椒盐碎屑，同时保持轮廓不收缩
export function median3(mask, W, H) {
  const out = new Uint8Array(W * H);
  const win = new Array(9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          win[n++] = mask[yy * W + xx];
        }
      }
      const s = win.slice(0, n).sort((a, b) => a - b);
      out[y * W + x] = s[n >> 1];
    }
  }
  return out;
}

/* ------------------------------- 分割主流程 ------------------------------- */

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// 双线性把 size×size 的概率图放大到 W×H
function upsample(src, size, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = ((y + 0.5) * size / H) - 0.5;
    const y0 = Math.max(0, Math.min(size - 1, Math.floor(fy)));
    const y1 = Math.min(size - 1, y0 + 1);
    const wy = fy - y0 < 0 ? 0 : (fy > y0 ? Math.min(1, fy - y0) : 0);
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) * size / W) - 0.5;
      const x0 = Math.max(0, Math.min(size - 1, Math.floor(fx)));
      const x1 = Math.min(size - 1, x0 + 1);
      const wx = fx < x0 ? 0 : (fx > x0 ? Math.min(1, fx - x0) : 0);
      const a = src[y0 * size + x0] * (1 - wx) + src[y0 * size + x1] * wx;
      const b = src[y1 * size + x0] * (1 - wx) + src[y1 * size + x1] * wx;
      out[y * W + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

/**
 * 抠出人物主体。
 * @param {string} input 输入图片
 * @param {string} model onnx 模型路径
 * @param {object} [opts]
 * @param {number} [opts.size] 模型输入边长，默认 320
 * @param {number} [opts.alphaFloor] alpha 硬阈值（0~1），低于此值视为背景
 * @param {number} [opts.soft] alpha 过渡带宽度，0~0.5；0=硬边
 * @param {number} [opts.closeR] 后处理闭运算半径，补主体内部断裂
 * @param {boolean} [opts.keepLargest] 只保留最大连通域，去掉背景杂散
 * @param {boolean} [opts.fillInner] 填充主体内部孔洞（白衬衫常被误判成背景）
 * @returns {Promise<{ width:number, height:number, alpha:Uint8Array, coverage:number }>}
 */
export async function segmentSubject(input, model, {
  size = 320, alphaFloor = 0.4, closeR = 8, grow = 26, vividSat = 0.32, darkL = 44, stretch = true,
  brightL = 236, brightSat = 0.1,
  maxHolePct = 0.012, stripVivid = 1, edgeDepth = 2, openR = 6, hiEdge = 0.75, expandR = 2,
  outlineL = 78, outlineSat = 0.34, noLineDist = 13, median = 1,
  bgDeltaE = 16, sampleRing = 14, wipeDist = 14, wipeConf = 0.3,
  speckRatio = 0.06, speckMin = 24,
  keepLargest = true, fillInner = true,
} = {}) {
  const sharp = require('sharp');
  const ort = require('onnxruntime-node');

  const meta = await sharp(input).metadata();
  const W = meta.width;
  const H = meta.height;

  const { data: small } = await sharp(input)
    .resize(size, size, { kernel: 'cubic', fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const plane = size * size;
  const inputData = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    inputData[i] = (small[i * 4] / 255 - MEAN[0]) / STD[0];
    inputData[plane + i] = (small[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    inputData[2 * plane + i] = (small[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const session = await ort.InferenceSession.create(model);
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', inputData, [1, 3, size, size]) };
  const res = await session.run(feeds);
  const pred = res[session.outputNames[0]].data;

  // U2-Net 输出已经是 sigmoid 概率。
  // stretch=false 时直接用原始值：sigmoid 对背景本来就压得很低（<0.1），阈值更好切，
  // 而且不会像 min-max 拉伸那样把背景的低概率硬拉到中高值、把背景条纹误判成前景。
  let prob;
  if (stretch) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of pred) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    prob = new Float32Array(plane);
    for (let i = 0; i < plane; i++) prob[i] = (pred[i] - lo) / span;
  } else {
    prob = Float32Array.from(pred);
  }

  const big = upsample(prob, size, W, H);

  // 高饱和像素：橙/红/黄这类彩色背景。区域生长到这里就停 —— 人物的白衬衫、皮肤都是低饱和的，
  // 彩色背景是高饱和的，所以"模型定位 + 饱和度设边界"比单靠模型可靠得多。
  const vivid = new Uint8Array(W * H);
  const veryDark = new Uint8Array(W * H);
  const tooBright = new Uint8Array(W * H);
  {
    const { data: orig } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < W * H; i++) {
      const r = orig[i * 4];
      const g = orig[i * 4 + 1];
      const b = orig[i * 4 + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = (mx - mn) / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      vivid[i] = sat > vividSat ? 1 : 0;
      // 生长阶段避开的"深色"：人物头发已被模型框住不会受影响，这里只拦背景里的深色块
      veryDark[i] = lum < darkL ? 1 : 0;
      // 极亮且几乎无彩色 = 白/米色纸背景。人物的白衬衫、眼白也会命中，
      // 但它们被深色轮廓包围属于内部孔洞，后面填洞会补回来；背景块补不回来。
      tooBright[i] = lum > brightL && sat < brightSat ? 1 : 0;
    }
  }

  const bgish = new Uint8Array(W * H);
  {
    // 背景色中心：从原图四周采样聚类。再算每个像素到最近背景色的 Lab 距离 ——
    // 背景条纹的抗锯齿过渡色（棕灰、灰白）饱和度不高，靠 vivid/dark/bright 都抓不住，
    // 但它们离背景色中心很近，用色差能认出来。
    const { data: orig } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ring = Math.max(2, Math.min(30, sampleRing));
    const border = [];
    const oat = (x, y) => [orig[(y * W + x) * 4], orig[(y * W + x) * 4 + 1], orig[(y * W + x) * 4 + 2]];
    for (let x = 0; x < W; x++) for (let r = 0; r < ring; r++) border.push(oat(x, r), oat(x, H - 1 - r));
    for (let y = 0; y < H; y++) for (let r = 0; r < ring; r++) border.push(oat(r, y), oat(W - 1 - r, y));
    const centers = kmeansLab(border.map(rgbToLab), 6).map((c) => c.center);
    for (let i = 0; i < W * H; i++) {
      const lab = rgbToLab([orig[i * 4], orig[i * 4 + 1], orig[i * 4 + 2]]);
      let bd = Infinity;
      for (const c of centers) { const d = deltaE(lab, c); if (d < bd) bd = d; }
      const looksBg = bd < bgDeltaE;
      bgish[i] = (vivid[i] || veryDark[i] || tooBright[i] || looksBg) ? 1 : 0;
    }
  }
  const isBackgroundish = (i) => bgish[i] === 1;

  // 漫画描边图：又暗又不艳的像素 = 黑色勾线。人物身上的每一块（发、脸、衣服、橙色发带）
  // 都有勾线围着，背景条纹则完全没有。所以「彩色背景色 + 附近一条描边都没有」= 一定是背景残留。
  const outline = new Uint8Array(W * H);
  {
    const { data: orig } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < W * H; i++) {
      const r = orig[i * 4];
      const g = orig[i * 4 + 1];
      const b = orig[i * 4 + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < outlineL && (mx - mn) / 255 < outlineSat) outline[i] = 1;
    }
  }
  const lineDist = distanceFrom(outline, W, H);

  let bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = big[i] >= alphaFloor ? 1 : 0;

  // 闭运算：把模型漏掉的身体/衣服和头部连起来
  if (closeR > 0) bin = close(bin, W, H, closeR);

  // 低饱和区域生长：沿着白衬衫、皮肤继续扩，撞到彩色/深色/纸白背景才停
  for (let step = 0; step < grow; step++) {
    const d = dilate(bin, W, H, 1);
    const nb = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) nb[i] = bin[i] || (d[i] && !isBackgroundish(i)) ? 1 : 0;
    bin = nb;
  }

  const maxHole = Math.round(maxHolePct * W * H);
  if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  if (keepLargest) bin = largestComponent(bin, W, H).mask;
  if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  if (expandR > 0) bin = dilate(bin, W, H, expandR);

  // 最后清理。形态学会把与人物交错穿插的背景块裹进来，用两条规则区分「残留」和「人物自身的颜色」：
  //   1) 与画面外部连通的背景样像素 = 真背景残留，剔除（环绕人物的橙条就是这种）；
  //   2) 紧贴人物边界的背景样像素 = 边缘混合污染，剔除（深度 <= edgeDepth）。
  // 人物自己的橙发带、红项圈、白衬衫、深色头发都被轮廓包住，既不与外部连通、深度也够大，不会被误删。
  if (stripVivid) {
    const extV = floodFromBorder(vivid, W, H);
    const extB = floodFromBorder(tooBright, W, H);
    const extD = floodFromBorder(veryDark, W, H);
    const depth = depthFromBorder(bin, W, H);
    for (let i = 0; i < W * H; i++) {
      if (!bin[i]) continue;
      if (extV[i] || extB[i] || extD[i]) bin[i] = 0;
      else if (isBackgroundish(i) && depth[i] <= edgeDepth) bin[i] = 0;
      else if (isBackgroundish(i) && lineDist[i] > noLineDist) bin[i] = 0;
    }
    bin = erode(bin, W, H, stripVivid);
    if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  }

  // 残留的橙条是「细长条」，人物主体是很宽的块 —— 开运算（先腐蚀后膨胀）能把窄条整个去掉，
  // 主体宽度远大于半径所以完好无损，只是发丝这类细节会略微收干净（拼豆图纸上本来也做不出来）。
  if (openR > 0) {
    bin = open(bin, W, H, openR);
    if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  }

  // 外部距离判据：碎片几乎都紧贴着已经确定是背景的区域（人物轮廓的凹陷处），
  // 而人物本体（脸、头发、衬衫、橙发带）四周都被自己的内容包着，离背景很远。
  // 用「到最近背景像素的距离」把这层残留擦掉 —— 形态学断开不了它们，它们和人物是连通的整体。
  if (wipeDist > 0) {
    const outside = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) outside[i] = bin[i] ? 0 : 1;
    const distOut = distanceFrom(outside, W, H);
    for (let i = 0; i < W * H; i++) {
      if (bin[i] && bgish[i] && distOut[i] <= wipeDist && big[i] < wipeConf) bin[i] = 0;
    }
    if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  }

  // 最后一道路闸：把明显小于主体的连通块整块丢掉。
  // 前面每一步形态学都可能把背景碎片重新粘回人物身上，等到这里它们已经是「连着的」，
  // largestComponent 已经救不回来了；按面积门槛逐块剔除才是有效的。
  if (speckRatio > 0) {
    bin = filterComponents(bin, W, H, speckRatio, speckMin);
    if (fillInner) bin = fillHoles(bin, W, H, maxHole);
  }
    // 二值 mask 回填 alpha：主体实心，边缘用模型概率羽化一格
  const alpha = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!bin[i]) { alpha[i] = 0; continue; }
    const v = big[i];
    alpha[i] = v >= hiEdge ? 255 : Math.round(Math.max(200, v * 255));
  }

  if (median > 0) {
    const bin2 = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) bin2[i] = alpha[i] >= 128 ? 1 : 0;
    const sm = median3(bin2, W, H);
    for (let i = 0; i < W * H; i++) alpha[i] = sm[i] ? Math.max(alpha[i], 200) : 0;
  }

  let sum = 0;
  for (let i = 0; i < W * H; i++) sum += alpha[i];
  return { width: W, height: H, alpha, conf: big, bgish, coverage: sum / (255 * W * H) };
}

/**
 * 用分割结果把背景换成纯色，并自动裁到人物外接框（留 pad 比例的余白）。
 * @param {object} seg segmentSubject 的返回值
 * @param {string} out 输出路径
 * @param {string} bg 背景色（#RRGGBB）
 * @param {{ pad?: number, lowConf?: number }} [opts]
 *   pad = 四周留白占人物长边的比例
 *   lowConf = 模型置信度低于此值的像素，即使落在人物 mask 内也直接输出背景色。
 *     这一步很关键：形态学会把模型本不认可的背景条纹吸进人物轮廓里，靠 mask 分不掉，
 *     但模型对这些条子的置信度本来就很低，直接按背景色画出来视觉上就是干净的白底人物。
 * @returns {Promise<{ width:number, height:number, box:number[] }>}
 */
export async function compositeOnColor(input, seg, out, bg = '#FFFFFF', { pad = 0.03, lowConf = 0, keepAlpha = false } = {}) {
  const sharp = require('sharp');
  const { width: W, height: H, alpha } = seg;

  // 人物外接框
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error('分割结果为空：没有检测到人物');
  const p = Math.round(Math.max(x1 - x0, y1 - y0) * pad);
  x0 = Math.max(0, x0 - p);
  y0 = Math.max(0, y0 - p);
  x1 = Math.min(W - 1, x1 + p);
  y1 = Math.min(H - 1, y1 + p);

  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const { data: base } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = bg && bg.startsWith('#')
    ? [parseInt(bg.slice(1, 3), 16), parseInt(bg.slice(3, 5), 16), parseInt(bg.slice(5, 7), 16)]
    : [255, 255, 255];

  const px = Buffer.alloc(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const si = (y + y0) * W + (x + x0);
          const di = (y * cw + x) * 4;
          // 低置信度的背景样像素直接画成背景色/透明：形态学会把模型本不认可的背景条纹
          // 吸进人物轮廓里，靠 mask 分不掉，但模型对这些条子的置信度本来就很低
          const lowHit = lowConf > 0 && seg.conf && seg.bgish && seg.bgish[si] && seg.conf[si] < lowConf;
          if (keepAlpha) {
            px[di] = base[si * 4];
            px[di + 1] = base[si * 4 + 1];
            px[di + 2] = base[si * 4 + 2];
            px[di + 3] = lowHit ? 0 : alpha[si];
          } else {
            const a = lowHit ? 0 : alpha[si] / 255;
            px[di] = Math.round(base[si * 4] * a + rgb[0] * (1 - a));
            px[di + 1] = Math.round(base[si * 4 + 1] * a + rgb[1] * (1 - a));
            px[di + 2] = Math.round(base[si * 4 + 2] * a + rgb[2] * (1 - a));
            px[di + 3] = 255;
          }
        }
      }
  await sharp(px, { raw: { width: cw, height: ch, channels: 4 } }).png().toFile(out);
  return { width: cw, height: ch, box: [x0, y0, cw, ch] };
}