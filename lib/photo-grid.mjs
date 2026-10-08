// 照片 -> 拼豆网格：网格线追踪、色卡提取、抗文字污染的逐格取色与分类
import { Jimp } from 'jimp';
import { hexToRgb, rgbToLab, deltaE } from './color.mjs';

export function loadImageGray(img) {
  const { width: W, height: H, data } = img.bitmap;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { gray, W, H };
}

const at = (g, W, x, y) => g[y * W + x];

// ---------- 自动定位网格区：排除手机黑边、坐标标号、材料清单 ----------
export function detectGridBands(img) {
  const { gray, W, H } = loadImageGray(img);
  const rowMean = new Float32Array(H);
  const colMean = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) s += at(gray, W, x, y);
    rowMean[y] = s / W;
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += at(gray, W, x, y);
    colMean[x] = s / H;
  }
  const extent = (arr, thresh) => {
    // 取「最长的一段连续高亮度区」当纸面，避免被底部小白条之类的孤立亮行带偏
    const segs = [];
    let start = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > thresh) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        segs.push([start, i - 1]);
        start = -1;
      }
    }
    if (start >= 0) segs.push([start, arr.length - 1]);
    segs.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
    return segs[0] || [0, arr.length - 1];
  };
  const [ry0, ry1] = extent(rowMean, 60);   // 纸面（排除上下黑边）
  const [rx0, rx1] = extent(colMean, 60);
  // 网格线能量：只统计横线信号时排除左右坐标标号列
  const rowEdge = new Float32Array(H);
  for (let y = 2; y < H - 2; y++) {
    let s = 0;
    for (let x = Math.max(1, rx0 + 2); x < Math.min(W - 1, rx1 - 2); x++) s += Math.abs(at(gray, W, x, y + 1) - at(gray, W, x, y - 1));
    rowEdge[y] = s;
  }
  const colEdge = new Float32Array(W);
  for (let x = 2; x < W - 2; x++) {
    let s = 0;
    for (let y = Math.max(1, ry0 + 2); y < Math.min(H - 1, ry1 - 2); y++) s += Math.abs(at(gray, W, x + 1, y) - at(gray, W, x - 1, y));
    colEdge[x] = s;
  }
  // 取「最长的一段连续高能量区」，它就是网格本体（清单区/标号区能量明显更低）
  const longestBand = (sig, lo, hi) => {
    const seg = [];
    let mx = 0;
    for (let i = lo; i <= hi; i++) if (sig[i] > mx) mx = sig[i];
    const th = mx * 0.45;
    let start = -1;
    for (let i = lo; i <= hi; i++) {
      if (sig[i] >= th) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        seg.push([start, i - 1, i - start]);
        start = -1;
      }
    }
    if (start >= 0) seg.push([start, hi, hi - start + 1]);
    seg.sort((a, b) => b[2] - a[2]);
    return seg[0] || [lo, hi, hi - lo];
  };
  const [gy0, gy1] = longestBand(rowEdge, ry0, ry1);
  const [gx0, gx1] = longestBand(colEdge, rx0, rx1);
  // 网格区检测失败时（能量分布异常）退回纸面范围
  const gw = gx1 - gx0;
  const gh = gy1 - gy0;
  const grid = gw > 0.3 * (rx1 - rx0) && gh > 0.3 * (ry1 - ry0)
    ? { x0: gx0, x1: gx1, y0: gy0, y1: gy1 }
    : { x0: rx0, x1: rx1, y0: ry0, y1: ry1 };
  return {
    page: { x0: rx0, x1: rx1, y0: ry0, y1: ry1 },
    grid,
  };
}

// ---------- 网格线追踪 ----------
export function lineSignal({ gray, W, H }, axis, band) {
  // axis 'x'：竖线信号（x 方向梯度沿 y 累加）；axis 'y'：横线信号
  const sig = new Float32Array(axis === 'x' ? W : H);
  if (axis === 'x') {
    for (let x = 1; x < W - 1; x++) {
      let s = 0;
      let n = 0;
      for (let y = band.y0; y < band.y1; y++) {
        if (y <= 0 || y >= H - 1) continue;
        s += Math.abs(at(gray, W, x + 1, y) - at(gray, W, x - 1, y));
        n++;
      }
      sig[x] = n ? s / n : 0;
    }
  } else {
    for (let y = 1; y < H - 1; y++) {
      let s = 0;
      let n = 0;
      for (let x = band.x0; x < band.x1; x++) {
        if (x <= 0 || x >= W - 1) continue;
        s += Math.abs(at(gray, W, x, y + 1) - at(gray, W, x, y - 1));
        n++;
      }
      sig[y] = n ? s / n : 0;
    }
  }
  // 轻度平滑，压掉单像素噪点
  const sm = new Float32Array(sig.length);
  for (let i = 1; i < sig.length - 1; i++) sm[i] = (sig[i - 1] + 2 * sig[i] + sig[i + 1]) / 4;
  return sm;
}

export function traceLines(sig, period, lo, hi, expect = 0) {
  // 种子不能只看「最强峰」——照片里的水印、黑边都可能更强。
  // 用「周期性得分」选：候选位置 p 沿着 period 能连续命中多少条网格线。
  // 所有候选用同一个 k 区间、越界计 0，保证得分可比。
  const val = (i) => (i < lo || i >= hi || i < 1 || i >= sig.length - 1 ? 0 : sig[i]);
  const K = Math.ceil((hi - lo) / period);
  let seed = lo;
  let bestScore = -1;
  for (let p = lo; p < hi; p += 0.25) {
    let s = 0;
    for (let k = -K; k <= K; k++) s += val(Math.round(p + k * period));
    const score = s / (2 * K + 1);
    if (score > bestScore) { bestScore = score; seed = p; }
  }
  seed = Math.round(seed);
  // 严格模式只认局部极大；线太弱时会断链，所以线数不够时再用宽松模式（取邻域最大值）兜底
  const trace = (strict) => {
    const step = (k) => {
      const c = seed + k * period;
      let best = -1;
      let bv = strict ? 0 : -Infinity;
      for (let i = Math.round(c - 1.6); i <= Math.round(c + 1.6); i++) {
        if (i < lo || i >= hi) continue;
        const isMax = val(i) >= val(i - 1) && val(i) > val(i + 1);
        if ((strict ? isMax : true) && val(i) > bv) { bv = val(i); best = i; }
      }
      return best;
    };
    const seq = [];
    for (let k = 0; ; k++) {
      const p = step(k);
      if (p < 0) break;
      seq.push(p);
    }
    for (let k = 1; ; k++) {
      const p = step(-k);
      if (p < 0) break;
      seq.unshift(p);
    }
    seq.sort((a, b) => a - b);
    return seq;
  };
  const hard = trace(true);
  if (expect && hard.length < expect) {
    const soft = trace(false);
    if (soft.length > hard.length) return soft;
  }
  // 纸边/黑边在搜索范围两端制造的伪峰（坐标数字、裁剪阴影）紧贴边界，先剔除；
  // 剔除后数量不够就说明那些确实是真的，保留原样。
  const pad = 5;
  const cleaned = hard.filter((p) => p > lo + pad && p < hi - pad);
  const need = expect || 3;
  return cleaned.length >= need ? cleaned : hard;
}

export function fitLines(seq, count, sig = null) {
  const lsq = (pts) => {
    const n = pts.length;
    const mk = (n - 1) / 2;
    const mp = pts.reduce((s, v) => s + v, 0) / n;
    let num = 0; let den = 0;
    for (let i = 0; i < n; i++) { num += (i - mk) * (pts[i] - mp); den += (i - mk) ** 2; }
    const a = den ? num / den : 1;
    const b = mp - a * mk;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += (pts[i] - (a * i + b)) ** 2;
    return { origin: b, period: a, count: n, rms: Math.sqrt(rms / n), lines: pts };
  };
  // 相位可能整体差一格（多检出/漏检一条线）。网格线是连续贯穿的整条线，强度彼此接近；
  // 坐标数字、图案边界只是局部强；而且每 5 格有一条粗线，粗线组必然比其余线明显更强。
  const sigVal = (x) => {
    const i = Math.round(x);
    return i >= 0 && i < sig.length ? sig[i] : 0;
  };
  const scoreOf = (fit) => {
    if (!sig || fit.count < 6) return fit.rms;
    const pts = fit.lines;
    const T = fit.period;
    const vals = pts.map(sigVal);
    const allMean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const minInside = Math.min(...vals);
    let bestGroup = 0;
    for (const r of [0, 1, 2, 3, 4]) {
      const g = vals.filter((_, i) => i % 5 === r);
      const m = g.reduce((a, b) => a + b, 0) / g.length;
      if (m > bestGroup) bestGroup = m;
    }
    return fit.rms - 0.5 * Math.max(0, bestGroup - allMean) - 0.4 * Math.max(0, minInside - allMean);
  };
  if (seq.length <= count) {
    // 追踪到的线不够，按已有周期向两端延伸补齐（漏检的线用线性模型补）
    const base = lsq(seq);
    if (seq.length >= 2) {
      const first = base.origin;
      const last = base.origin + base.period * (seq.length - 1);
      const need = count - seq.length;
      for (let i = 1; i <= Math.ceil(need / 2); i++) {
        const pre = first - base.period * i;
        if (pre >= seq[0] - base.period * 0.6) seq.unshift(pre);
      }
      for (let i = 1; i <= Math.ceil(need / 2); i++) {
        const post = last + base.period * i;
        if (post <= seq[seq.length - 1] + base.period * 0.6) seq.push(post);
      }
    }
    return lsq(seq);
  }
  // 多检出线：滑动窗口找「数量正好、拟合残差小、贴边合理」的一段
  let best = null;
  let bestScore = Infinity;
  for (let s = 0; s + count <= seq.length; s++) {
    const fit = lsq(seq.slice(s, s + count));
    const sc = scoreOf(fit);
    if (sc < bestScore) { bestScore = sc; best = fit; }
  }
  return best;
}

// 在已知的一组网格线位置上统计另一方向的线信号：交叉点处对比最强，
// 图案区和深色区（黑色格子、渐变背景）不会打断信号，比整幅投影稳得多。
export function crossSignal(img, axis, positions, lo, hi, half = 1) {
  const { gray, W, H } = img;
  const sig = new Float32Array(axis === 'x' ? W : H);
  const sample = (x, y) => gray[y * W + x];
  for (let a = Math.max(1, lo); a < Math.min((axis === 'x' ? W : H) - 1, hi); a++) {
    let s = 0;
    let n = 0;
    for (const p of positions) {
      const c = Math.round(p);
      for (let d = -half; d <= half; d++) {
        // a 是正在搜索的这条线的坐标，c 是另一方向已知网格线的坐标
        if (axis === 'x') {
          const y = c + d;
          if (y <= 0 || y >= H - 1) continue;
          s += Math.abs(sample(a + 1, y) - sample(a - 1, y));
        } else {
          const x = c + d;
          if (x <= 0 || x >= W - 1) continue;
          s += Math.abs(sample(x, a + 1) - sample(x, a - 1));
        }
        n++;
      }
    }
    sig[a] = n ? s / n : 0;
  }
  const sm = new Float32Array(sig.length);
  for (let i = 1; i < sig.length - 1; i++) sm[i] = (sig[i - 1] + 2 * sig[i] + sig[i + 1]) / 4;
  return sm;
}

// ---------- 色卡：材料清单里的色块 ----------
export function extractSwatches(img, rows) {
  // rows: [{y0, y1, count}]，每行色块从左到右等距排列。
  // 白色色块在照片上和白底分不开，检不出来，所以用「检出的色块间距」等距插值补齐。
  const { width: W, height: H, data } = img.bitmap;
  const rgbAt = (x, y) => {
    const o = (y * W + x) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const out = [];
  let spacing = null;
  for (const row of rows) {
    // 非白度剖面：色块偏离白底，间隙和水印文字接近 0
    const nw = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = row.y0; y <= row.y1; y++) {
        const c = rgbAt(x, y);
        s += Math.max(255 - c[0], 255 - c[1], 255 - c[2]);
      }
      nw[x] = s / (row.y1 - row.y0 + 1);
    }
    const segs = [];
    let start = -1;
    for (let x = 0; x < W; x++) {
      if (nw[x] > 8) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start >= 3) segs.push((start + x - 1) / 2);
        start = -1;
      }
    }
    if (start >= 0 && W - start >= 3) segs.push((start + W - 1) / 2);
    // 间距 = 相邻色块中心差的中位数（跳过明显更大的间隔，那是白色块造成的空档）
    const gaps = [];
    for (let i = 1; i < segs.length; i++) {
      const g = segs[i] - segs[i - 1];
      if (g > 8 && g < 60) gaps.push(g);
    }
    if (gaps.length >= 2) {
      gaps.sort((a, b) => a - b);
      spacing = gaps[Math.floor(gaps.length / 2)];
    }
    const T = spacing || 12;
    // 相位：各段中心对 T 取模的中位数
    const resid = segs.map((c) => ((c % T) + T) % T).sort((a, b) => a - b);
    const phase = resid.length ? resid[Math.floor(resid.length / 2)] : 0;
    for (let k = 0; k < row.count; k++) {
      let cx = phase + T * k;
      while (cx < 2) cx += T;
      const list = [];
      for (let dx = -2; dx <= 2; dx++) {
        for (let y = row.y0 + 1; y <= row.y1 - 1; y++) {
          const x = Math.round(cx) + dx;
          if (x >= 0 && x < W && y >= 0 && y < H) list.push(rgbAt(x, y));
        }
      }
      const ch = dominantColor(list);
      out.push({ rgb: ch, cx: +cx.toFixed(2), spacing: T, detected: segs.some((s) => Math.abs(s - cx) < T / 3) });
    }
  }
  return out;
}

// ---------- 逐格取色 ----------
export function sampleCells(img, geom, cols, rows) {
  const { width: W, height: H, data } = img.bitmap;
  const { x0, y0, tx, ty } = geom;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x0 + tx * 0.5 + c * tx;
      const cy = y0 + ty * 0.5 + r * ty;
      const rx = Math.max(1, Math.round(tx * 0.34));
      const ry = Math.max(1, Math.round(ty * 0.34));
      const list = [];
      // 整数像素步进，避免同一像素被重复采样把分布算歪
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const x = Math.round(cx) + dx;
          const y = Math.round(cy) + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const o = (y * W + x) * 4;
          list.push([data[o], data[o + 1], data[o + 2]]);
        }
      }
      cells.push(list);
    }
  }
  return cells;
}

// 格子底色 vs 格内色号文字：亮度上分成两簇，取像素更多的那簇当底色。
// 文字笔画再粗也只占少数像素，黑底白字的深色格子同样适用。
function dominantColor(list) {
  if (!list.length) return [128, 128, 128];
  const lum = list.map((p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]);
  let c1 = Math.min(...lum);
  let c2 = Math.max(...lum);
  let inA = [];
  let inB = [];
  if (c2 - c1 < 12) return medianRgb(list);
  for (let it = 0; it < 8; it++) {
    inA = [];
    inB = [];
    for (let i = 0; i < list.length; i++) {
      (Math.abs(lum[i] - c1) <= Math.abs(lum[i] - c2) ? inA : inB).push(list[i]);
    }
    if (!inA.length || !inB.length) break;
    const m = (arr) => arr.reduce((s, p) => s + 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2], 0) / arr.length;
    const n1 = m(inA);
    const n2 = m(inB);
    if (Math.abs(n1 - c1) < 0.4 && Math.abs(n2 - c2) < 0.4) { c1 = n1; c2 = n2; break; }
    c1 = n1;
    c2 = n2;
  }
  const big = inA.length >= inB.length ? inA : inB;
  return medianRgb(big.length ? big : list);
}

function medianRgb(list) {
  return [0, 1, 2].map((c) => {
    const v = list.map((p) => p[c]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  });
}

function medianLab(list, refLab, keep = 0.5) {
  // 参考色给定时，先按与它的色距排序，只取最像的一半像素再取中值：进一步剔除格内文字
  let use = list;
  if (refLab) {
    const scored = list.map((p) => [deltaE(rgbToLab(p), refLab), p]).sort((a, b) => a[0] - b[0]);
    use = scored.slice(0, Math.max(3, Math.ceil(scored.length * keep))).map((s) => s[1]);
  }
  const labs = use.map(rgbToLab);
  const ch = [0, 1, 2].map((c) => {
    const v = labs.map((l) => l[c]).sort((u, w) => u - w);
    return v[Math.floor(v.length / 2)];
  });
  return ch;
}

export function classifyCells(cells, refs, iterations = 3) {
  const refLabs = refs.map((c) => rgbToLab(c.rgb));
  // 初始估计用「亮度主簇」，避开格内色号文字的干扰
  const labs = cells.map((list) => rgbToLab(dominantColor(list)));
  const assign = new Int32Array(cells.length);
  const nearest = (lab) => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < refLabs.length; i++) {
      const d = deltaE(lab, refLabs[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  for (let i = 0; i < labs.length; i++) assign[i] = nearest(labs[i]);
  // 迭代：按当前分配的颜色剔除文字像素后重新估计
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < cells.length; i++) {
      const lab = medianLab(cells[i], refLabs[assign[i]]);
      labs[i] = lab;
      assign[i] = nearest(lab);
    }
  }
  return { assign, labs };
}

// 已知每色数量时，按数量约束把代价最小的格子挪过去
export function balanceToCounts(assign, labs, refs, targets) {
  const refLabs = refs.map((c) => rgbToLab(c.rgb));
  const count = refs.map(() => 0);
  for (let i = 0; i < assign.length; i++) count[assign[i]]++;
  let guard = 0;
  while (guard++ < assign.length * 4) {
    let over = -1;
    let under = -1;
    for (let c = 0; c < refs.length; c++) {
      if (count[c] > targets[c] && over < 0) over = c;
      if (count[c] < targets[c] && under < 0) under = c;
    }
    if (over < 0 || under < 0) break;
    // 在超额的色里找「改成亏额色代价最小」的格子
    let bestI = -1;
    let bestCost = Infinity;
    for (let i = 0; i < assign.length; i++) {
      if (assign[i] !== over) continue;
      const cost = deltaE(labs[i], refLabs[over]) - deltaE(labs[i], refLabs[under]);
      if (cost < bestCost) { bestCost = cost; bestI = i; }
    }
    if (bestI < 0) break;
    assign[bestI] = under;
    count[over]--;
    count[under]++;
  }
  return assign;
}

// ---------- 校验：照片 与 还原结果 并排对比 ----------
export async function renderCompare(img, geom, cols, rows, grid, colors, file, scale = 5) {
  const { x0, y0, tx, ty } = geom;
  const left = img.crop({
    x: Math.round(x0), y: Math.round(y0),
    w: Math.round(cols * tx), h: Math.round(rows * ty),
  }).scale(scale, scale);
  const LW = left.bitmap.width;
  const LH = left.bitmap.height;
  const right = new Jimp({ width: LW, height: LH, color: 0xffffff });
  const rb = right.bitmap;
  const rgbOf = colors.map((c) => {
    const h = c.hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [cr, cg, cb] = rgbOf[grid[r * cols + c]] || [255, 0, 255];
      const ax = Math.round((c * LW) / cols);
      const bx = Math.round(((c + 1) * LW) / cols);
      const ay = Math.round((r * LH) / rows);
      const by = Math.round(((r + 1) * LH) / rows);
      for (let y = ay; y < by; y++) {
        for (let x = ax; x < bx; x++) {
          const o = (y * LW + x) * 4;
          rb.data[o] = cr; rb.data[o + 1] = cg; rb.data[o + 2] = cb; rb.data[o + 3] = 255;
        }
      }
    }
  }
  const gap = 24;
  const out = new Jimp({ width: LW * 2 + gap, height: LH, color: 0x101010 });
  out.composite(left, 0, 0);
  out.composite(right, LW + gap, 0);
  await out.write(file);
}

export { hexToRgb, rgbToLab, deltaE };