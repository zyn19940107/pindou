// 图片分析工具：把出图过程中本来要靠肉眼/临时脚本判断的几件事变成可调用函数。
//
// 为什么单独放一个模块：这些判断在命令行流程里通常是「先手动量一下、再把数字敲进 --crop」，
// 量错了（目测 24px 实测 11px）就会生成一版注定糊的图纸，等到看图才发现就晚了。
// 这里把它们收敛成 API，GUI 可以先算、先警告，再决定要不要出图。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';
import { hexToRgb } from './color.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 大图先缩到最长边 maxSide 再扫，纯统计不需要原始像素，缩放后结果一致但快很多。
const MAX_SIDE = 1600;

function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// 把像素坐标映射回原图尺度，检测在缩略图上做的，返回仍是原图坐标。
function makeScaler(w, h, ow, oh) {
  return {
    toOrig: (x, y) => ({
      x: Math.round((x + 0.5) * (ow / w) - 0.5),
      y: Math.round((y + 0.5) * (oh / h) - 0.5),
    }),
  };
}

async function loadScaled(imgPath, maxSide = MAX_SIDE) {
  const img = await Jimp.read(imgPath);
  const ow = img.bitmap.width;
  const oh = img.bitmap.height;
  if (Math.max(ow, oh) <= maxSide) return { img, ow, oh, scale: 1 };
  const r = maxSide / Math.max(ow, oh);
  const w = Math.max(1, Math.round(ow * r));
  const h = Math.max(1, Math.round(oh * r));
  await img.resize({ w, h, mode: 'bilinear-interpolation' });
  return { img, ow, oh, scale: r };
}

/**
 * 主体外接框：扫出「非背景」像素的包围盒，等价于手工扫一遍非白像素。
 * 背景判定用四角采样：取图片四角的像素作为背景色，容差 threshold 内的算背景。
 * 这样白底图、米底图、透明底图都能处理，不需要用户指定背景色。
 */
export async function detectSubjectBBox(imgPath, opts = {}) {
  const threshold = opts.threshold ?? 18;
  const padRatio = opts.padRatio ?? 0.04;
  const { img, ow, oh } = await loadScaled(imgPath);
  const { width: w, height: h, data } = img.bitmap;

  // 四角采样确定背景色（取样本中位，避免角落恰好压到主体）。
  const samples = [
    [1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2],
    [Math.floor(w / 2), 1], [Math.floor(w / 2), h - 2],
    [1, Math.floor(h / 2)], [w - 2, Math.floor(h / 2)],
  ].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });
  const med = [0, 1, 2].map((k) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });

  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.abs(data[i] - med[0]) + Math.abs(data[i + 1] - med[1]) + Math.abs(data[i + 2] - med[2]);
      if (d > threshold * 3) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    // 整张图都是背景色（纯色图），没有主体可言，退回整幅。
    return { found: false, bbox: { x: 0, y: 0, w: ow, h: oh }, crop: { x: 0, y: 0, w: ow, h: oh }, imageW: ow, imageH: oh, bgColor: med };
  }

  const sc = makeScaler(w, h, ow, oh);
  const tl = sc.toOrig(minX, minY);
  const br = sc.toOrig(maxX, maxY);
  let x = Math.max(0, tl.x);
  let y = Math.max(0, tl.y);
  let bw = Math.min(ow, br.x) - x;
  let bh = Math.min(oh, br.y) - y;
  const pad = Math.round(Math.max(bw, bh) * padRatio);
  x = Math.max(0, x - pad);
  y = Math.max(0, y - pad);
  bw = Math.min(ow - x, bw + pad * 2);
  bh = Math.min(oh - y, bh + pad * 2);

  return {
    found: true,
    bbox: { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y },
    crop: { x, y, w: bw, h: bh },
    coverage: +(count / (w * h)).toFixed(4),
    bgColor: med,
    imageW: ow,
    imageH: oh,
  };
}

/**
 * 眼部测量：先做暗块连通域，再按「成对 + 被亮色包围 + 体量小」挑出眼睛。
 *
 * 早期版本用「逐行亮度阈值找连续暗段」，在插画头像上全军覆没：
 *   - 橙色条纹背景亮度约 148，和 110 级的暗阈值只差一点点，横向直接连通成一片；
 *   - 棕色虹膜亮度 99~120，正好卡在阈值边缘，成对暗段时断时续；
 *   - 头发暗块纵向贯穿整张脸，逐行法分不出「眼睛」和「头发」。
 * 人像原图量出 4px 眼宽（实测 20px），错到没有参考价值。
 *
 * 现在的判据是眼睛的三个物理特征：
 *   1. 体量小 —— 宽不超过画幅 18%、高不超过 14%，头发/衣领直接出局；
 *   2. 被亮色包围 —— 眼睛四周一圈平均亮度显著高于块内（眼白/脸颊/鼻梁都是亮的）；
 *   3. 成对且近似对称 —— 纵向中心接近、宽度接近、间距在 0.3~2.6 倍眼宽之间。
 * 这三条对动漫人像、猫狗宠物都成立，且不依赖背景色。
 */
export async function detectEyeMetrics(imgPath, opts = {}) {
  const maxWidthRatio = opts.maxWidthRatio ?? 0.18;
  const maxHeightRatio = opts.maxHeightRatio ?? 0.14;
  const minEyeRatio = opts.minEyeRatio ?? 0.025;
  const minFill = opts.minFill ?? 0.28;
  // 局部阈值会把「橙色条纹背景」这类中等亮度块也判成暗（均亮 110+），眼睛是真深色（均亮 40~70），
  // 用块均亮把前者挡掉，比靠形状和位置猜要稳。
  const maxBlobMean = opts.maxBlobMean ?? 105;
  // 环绕对比：块外一圈必须显著比块内亮（眼白/脸颊包住瞳孔）。
  // 默认 45 是实测定的：猫眼 61、人物 81，而核桃上的深色接缝只有 37 —— 它并不被亮色包围，
  // 只是「恰好成对且纵向对齐」。低于 45 的暗块更可能是物体纹理而非眼睛。
  const minContrast = opts.minContrast ?? 45;
  // 间距上限。实测核桃上「两处深色接缝」被当成双眼：眼宽 18px、间距 104px，是眼宽的 5.8 倍。
  // 真实双眼的空白间距不超过约 2.5 倍眼宽（猫眼最宽的三角眼也就 2 倍），超过就不是眼睛。
  const maxGapRatio = opts.maxGapRatio ?? 2.6;
  const { img, ow, oh } = await loadScaled(imgPath);
  const { width: w, height: h, data } = img.bitmap;
  const sc = makeScaler(w, h, ow, oh);

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = lum(data[p], data[p + 1], data[p + 2]);
  }

  // 阈值：给了 darkLevel 就用固定值，否则按「局部均值 - k 倍局部标准差」逐像素算。
  // 固定阈值在人像上必然翻车：同一张脸里，左眼有黑睫毛线（均亮 39），
  // 右眼被刘海压住、虹膜偏亮（110~130），固定 120 只剩一只眼，另一只直接漏检。
  const thr = opts.darkLevel
    ? null
    : localThreshold(gray, w, h, {
      window: Math.max(3, Math.round(Math.max(w, h) / 20)),
      k: opts.k ?? 0.9,
      lo: opts.minLevel ?? 25,
      hi: opts.maxLevel ?? 190,
    });

  const blobs = darkBlobs(gray, thr, w, h)
    .map((b) => ({
      ...b,
      bw: b.maxX - b.minX + 1,
      bh: b.maxY - b.minY + 1,
      cx: (b.minX + b.maxX) / 2,
      cy: (b.minY + b.maxY) / 2,
      fill: b.count / ((b.maxX - b.minX + 1) * (b.maxY - b.minY + 1)),
    }))
    .filter((b) => b.bw <= w * maxWidthRatio && b.bh <= h * maxHeightRatio && b.bw >= Math.max(2, w * minEyeRatio) && b.fill >= minFill && b.mean <= maxBlobMean);
  if (blobs.length < 2) {
    return { found: false, reason: `暗块不足两个（找到 ${blobs.length} 个），可能不是人像/动物正视图`, imageW: ow, imageH: oh };
  }
  for (const b of blobs) b.contrast = +(ringLuma(gray, w, h, b) - b.mean).toFixed(1);
  if (opts.debug) debugBlobs(blobs, w, h);

  const pair = pickEyePair(blobs, { minContrast, imgW: w, maxGapRatio });
  if (!pair) {
    return {
      found: false,
      reason: `找到 ${blobs.length} 个暗块，但没有一对同时满足「纵向对齐、宽度接近、间距合理、外围更亮」（对比度需>${minContrast}）`,
      imageW: ow, imageH: oh,
    };
  }

  const toOrigX = (v) => sc.toOrig(v, 0).x;
  const toOrigY = (v) => sc.toOrig(0, v).y;
  const lw = Math.round((pair.left.bw + pair.right.bw) / 2);
  const lh = Math.round((pair.left.bh + pair.right.bh) / 2);
  const lineY = (pair.left.cy + pair.right.cy) / 2;
  const centerX = (pair.left.cx + pair.right.cx) / 2;
  const spanX = pair.right.maxX - pair.left.minX + 1;
  const conf = eyeConfidence(blobs.length, pair.contrast, minContrast, opts);

  return {
    found: true,
    eyePx: toOrigX(lw) - toOrigX(0),
    // 有一只眼被刘海/帽子压住时，平均值会高估清晰度；保守判断用这个最小值
    eyePxMin: Math.min(toOrigX(pair.left.bw), toOrigX(pair.right.bw)) - toOrigX(0),
    eyeHeightPx: toOrigY(lh) - toOrigY(0),
    eyeLineY: toOrigY(lineY),
    leftW: toOrigX(pair.left.bw) - toOrigX(0),
    rightW: toOrigX(pair.right.bw) - toOrigX(0),
    gapPx: toOrigX(pair.right.minX - pair.left.maxX) - toOrigX(0),
    contrast: Math.round(Math.min(pair.left.contrast, pair.right.contrast)),
    confidence: conf.level,
    note: conf.note,
    cxRatio: +(centerX / w).toFixed(3),
    // 双眼连成的包围盒原图坐标，用来直接拼裁剪参数
    box: {
      x: toOrigX(pair.left.minX), y: toOrigY(Math.min(pair.left.minY, pair.right.minY)),
      w: toOrigX(spanX) - toOrigX(0),
      h: toOrigY(Math.max(pair.left.maxY, pair.right.maxY) - Math.min(pair.left.minY, pair.right.minY)) - toOrigY(0),
    },
    candidates: blobs.length,
    imageW: ow,
    imageH: oh,
  };
}

// 逐像素局部阈值：thr = 局部均值 - k * 局部标准差，再用 [lo, hi] 夹住。
// 靠积分图做到 O(n)。纯色区（橙条纹背景、白底）方差小，阈值贴着均值，不会被误判成暗块；
// 眼睛/五官这种「局部有深色」的地方阈值自动下移，哪怕虹膜偏亮也能被切出来。
function localThreshold(gray, w, h, { window: r, k, lo, hi }) {
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  const sq = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v;
      rowSq += v * v;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rowSum;
      sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rowSq;
    }
  }
  const box = (x0, y0, x1, y1) => {
    const a = (y1 + 1) * W + (x1 + 1), b = y0 * W + (x1 + 1), c = (y1 + 1) * W + x0, d = y0 * W + x0;
    return [sum[a] - sum[b] - sum[c] + sum[d], sq[a] - sq[b] - sq[c] + sq[d]];
  };
  const thr = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const [s, ss] = box(x0, y0, x1, y1);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = s / n;
      const std = Math.sqrt(Math.max(0, ss / n - mean * mean));
      const v = mean - k * std;
      thr[y * w + x] = v < lo ? lo : v > hi ? hi : v;
    }
  }
  return thr;
}

// 暗像素的 4 邻域连通块。thr 为 null 时用固定阈值 gray < 120。
function darkBlobs(gray, thr, w, h, fixedLevel = 120) {
  const isDark = thr ? (i) => gray[i] < thr[i] : (i) => gray[i] < fixedLevel;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let i = 0; i < gray.length; i++) {
    if (seen[i] || !isDark(i)) continue;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0, sum = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      count++;
      sum += gray[p];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && isDark(p - 1)) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !seen[p + 1] && isDark(p + 1)) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !seen[p - w] && isDark(p - w)) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !seen[p + w] && isDark(p + w)) { seen[p + w] = 1; stack.push(p + w); }
    }
    out.push({ minX, minY, maxX, maxY, count, mean: sum / count });
  }
  return out;
}

// 暗块外一圈（外扩 2px）的平均亮度：眼睛被眼白/脸颊包着，头发不会。
function ringLuma(gray, w, h, b) {
  let sum = 0, n = 0;
  const pad = 2;
  for (let y = b.minY - pad; y <= b.maxY + pad; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = b.minX - pad; x <= b.maxX + pad; x++) {
      if (x < 0 || x >= w) continue;
      const onEdge = y === b.minY - pad || y === b.maxY + pad || x === b.minX - pad || x === b.maxX + pad;
      // 角上的外扩点离块太远，会把背景掺进来，只取四条边中段
      if (onEdge && (x < b.minX || x > b.maxX) && (y < b.minY || y > b.maxY)) continue;
      sum += gray[y * w + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

// 在暗块里挑最像「一对眼睛」的两块，返回代价最小的一对（没有则为 null）。
// 硬约束把「形状像眼睛」和「位置像脸」分开表达：单块要横向、实心、尺寸在合理比例内，
// 成对要纵向对齐、宽度接近、中间隔着鼻梁/眼白，最后按代价取最优。
function pickEyePair(blobs, { minContrast, imgW, maxGapRatio }) {
  const sorted = blobs.slice().sort((a, b) => a.cx - b.cx);
  const widest = Math.max(...sorted.map((b) => b.bw));
  // 尺寸先验：头像/半身里眼睛通常占画幅宽度 6%~8%，越接近越可信。
  // 不加这个先验，打分会被「又小又对称的碎块」（描边交叉点、鼻孔阴影）拉走。
  const preferredW = imgW * 0.07;
  let best = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const L = sorted[i], R = sorted[j];
      const avgH = (L.bh + R.bh) / 2;
      const avgW = (L.bw + R.bw) / 2;
      // 形状：横向的块才可能是眼睛，竖条（描边、衣领线）出局
      if (L.bw < L.bh * 0.6 || R.bw < R.bh * 0.6) continue;
      // 位置：纵向得对齐
      if (Math.abs(L.cy - R.cy) > Math.max(avgH, 2)) continue;
      // 尺寸：宽度得接近
      if (Math.abs(L.bw - R.bw) > avgW * 0.5) continue;
      // 间距：中间得是鼻梁/眼白，不能连成一坨也不能离太远
      const gap = R.minX - L.maxX;
      if (gap < avgW * 0.3 || gap > avgW * maxGapRatio) continue;
      // 成对后的总跨度不能过大（否则是「左耳 + 右耳」这种横跨全脸的组合）
      if (R.maxX - L.minX + 1 > widest * 4.5) continue;
      const contrast = Math.min(L.contrast, R.contrast);
      if (contrast < minContrast) continue;
      const cost = dy2(L, R) * 1.2
        + Math.abs(L.bw - R.bw) * 0.8
        + Math.abs(avgW - preferredW) * 0.6
        + avgH * 0.3
        - contrast * 0.25;
      if (!best || cost < best.cost) best = { left: L, right: R, cost, contrast, gap };
    }
  }
  return best;
}

const dy2 = (L, R) => Math.abs(L.cy - R.cy);

/**
 * 眼部检出置信度。存在的理由：核桃图上总有暗块能凑成「成对、纵向对齐、间距合理」，
 * 逐条收紧阈值只会让它不断换一对冒充眼睛（实测连换三次，对比度从 37 涨到 47 仍在阈值内）。
 * 与其继续拍阈值，不如把区别说清楚：
 *   一张脸 = 大面积亮 + 少数集中的暗结构；核桃 = 整幅图都是深浅纹理。
 * 候选暗块总数正是这个结构的直接体现，且与「哪一块是眼」无关，判据稳。
 * 实测：猫 8 块、人物 16 块、原图 29 块（都算 high），核桃 71 块（low）。
 */
function eyeConfidence(nBlobs, contrast, minContrast, opts = {}) {
  const maxBlobs = opts.maxCandidates ?? 60;
  const margin = contrast - minContrast;
  const notes = [];
  let level = 'high';
  if (nBlobs > maxBlobs) {
    level = 'low';
    notes.push(`${nBlobs} 个候选暗块超过 ${maxBlobs}：暗结构撒满整幅，更像纯物体图而不是人像/动物正脸`);
  } else if (margin < 10) {
    level = 'medium';
    notes.push(`环绕对比 ${contrast} 只比阈值 ${minContrast} 高 ${margin}，暗块并非明显被亮色包围，可能是巧合凑对`);
  }
  return { level, note: notes.length ? notes.join('；') : null };
}

// 调参用：--debug 时把过筛暗块按面积排序打出来，方便核对「哪块才是眼睛」。
function debugBlobs(blobs, w, h) {
  const top = blobs.slice().sort((a, b) => b.count - a.count).slice(0, 12);
  console.log(`  候选暗块 ${blobs.length} 个，按面积前 12：`);
  for (const b of top) {
    console.log(`    x:${String(b.minX).padStart(4)}..${String(b.maxX).padStart(4)} y:${String(b.minY).padStart(4)}..${String(b.maxY).padStart(4)}`
      + ` w:${String(b.bw).padStart(3)} h:${String(b.bh).padStart(3)} 面积:${String(b.count).padStart(6)}`
      + ` 填充:${b.fill.toFixed(2)} 均亮:${b.mean.toFixed(0)} 对比:${b.contrast}`);
  }
}

/**
 * 按色相区间过滤色卡。解决的问题：Midi 原色卡里的「藏青/墨绿/草绿」等冷色，
 * 在暖色调主体上不会被用到，只会在暗部因通道不均被误吸走，形成脏色块。
 * 例：猫脸与松鼠暗部曾被量化成 B05 藏青(79 颗)、C04 墨绿(16 颗)。
 */
export function filterPaletteByHue(palette, ranges, name = '自定义(色相过滤)') {
  const hueOf = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const d = mx - mn;
    if (!d) return null;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };
  const inRanges = (h) => {
    if (h === null) return false;
    return ranges.some((r) => {
      const [a, b] = r.from <= r.to ? [r.from, r.to] : [r.from, r.to + 360];
      const hh = r.from <= r.to ? h : h + 360;
      return hh >= a && hh <= b;
    });
  };
  const kept = palette.colors.filter((c) => !inRanges(hueOf(c.hex)));
  const dropped = palette.colors.filter((c) => inRanges(hueOf(c.hex)));
  return { name, colors: kept, dropped };
}

// 预置色相过滤档位：对应实际踩过的坑
export const HUE_PRESETS = {
  midi: { name: 'Midi 原色卡', ranges: [] },
  warm: { name: '暖色（剔除绿系）', ranges: [{ from: 90, to: 175 }] },
  warmCool: { name: '暖色（剔除绿+冷蓝）', ranges: [{ from: 90, to: 175 }, { from: 200, to: 280 }] },
  warmest: { name: '暖色（再剔紫）', ranges: [{ from: 90, to: 175 }, { from: 200, to: 300 }] },
};

/**
 * 清晰度校验：把「原图里眼宽多少像素」换算成「目标格数下眼睛几格宽」，
 * 在出图前就给出判断。经验刻度：
 *   >=8  瞳孔、虹膜、高光都能表达
 *   5-8 能看出眼睛朝向，有神
 *   3-5 能识别是眼睛，无神
 *   <3  一定糊成深色块
 */
export function evaluateEyeCells(eyePx, cropW, gridSize) {
  const cells = +(eyePx / cropW * gridSize).toFixed(1);
  let level, advice;
  if (cells >= 8) { level = 'good'; advice = '眼睛可完整表达，瞳孔/虹膜/高光都能分格'; }
  else if (cells >= 5) { level = 'ok'; advice = '眼睛可辨、有神，但虹膜细节有限'; }
  else if (cells >= 3) { level = 'weak'; advice = '仅能识别是眼睛，几乎无神'; }
  else { level = 'bad'; advice = '必然糊成深色块，需放大格数或放弃眼部特写'; }
  // 想达到某个目标格数，需要把画面裁到多宽
  const needFor = (target) => Math.round(eyePx / target * gridSize);
  return { eyePx, cropW, gridSize, cells, level, advice, cropWidthFor: { eight: needFor(8), five: needFor(5) } };
}

/**
 * 由眼宽反推裁剪框：要在 gridSize 格宽下让眼睛占 targetCells 格，
 * 方形裁框边长就是 eyePx / targetCells * gridSize，位置以双眼连线为锚点，
 * 纵向按 eyeYBias（眼睛在框内的相对高度，默认 0.42，留出额头）摆放。
 * 输出可直接拼成 --crop x,y,w,h，省掉「量了再手敲」这一步。
 */
export function suggestEyeCrop(eye, gridSize = 45, targetCells = 8, opts = {}) {
  if (!eye || !eye.found) return null;
  const side = Math.max(8, Math.round(eye.eyePx / targetCells * gridSize));
  const bias = opts.eyeYBias ?? 0.42;
  const midX = eye.box.x + eye.box.w / 2;
  const x = Math.round(midX - side / 2);
  const y = Math.round(eye.eyeLineY - side * bias);
  const cx = Math.max(0, Math.min(x, Math.max(0, eye.imageW - side)));
  const cy = Math.max(0, Math.min(y, Math.max(0, eye.imageH - side)));
  return {
    side,
    x: cx,
    y: cy,
    crop: `${cx},${cy},${side},${side}`,
    cells: +(eye.eyePx / side * gridSize).toFixed(1),
    clamped: cx !== x || cy !== y,
  };
}

/**
 * 构图建议：竖长/横长图做方形格子时，cover 会裁掉短边，
 * contain 会补白边浪费格子。这里算出两种方案各自损失多少，并给出建议。
 */
export function evaluateFit(imgW, imgH, gridSize = 45, padColorCost = 1) {
  const ratio = imgW / imgH;
  const cropLong = Math.min(imgW, imgH);
  const shortSideGrids = +(cropLong / Math.max(imgW, imgH) * gridSize).toFixed(1);
  const wasted = Math.round((gridSize * gridSize) * (1 - cropLong / Math.max(imgW, imgH)) * padColorCost);
  const advice = ratio > 1.06 || ratio < 0.945
    ? (ratio > 1.06 ? '图偏横：cover 会裁掉左右，建议先按主体紧裁再出图' : '图偏竖：cover 会裁掉上下（可能切到头顶/帽子），建议先按主体紧裁或用 contain')
    : '接近方形：cover 基本无损，可直接出图';
  return { ratio: +ratio.toFixed(3), coverGrids: gridSize, shortSideGrids, wastedGrids: wasted, advice };
}

export { ROOT };
