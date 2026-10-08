// 颜色空间转换、聚类量化、碎点清理

export function hexToRgb(hex) {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

export function rgbToLab([r, g, b]) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export const deltaE = (a, b) => {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db; // 平方距离，省一次开方
};

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

// 亮度/对比度/饱和度手动调整（HSL 域，避免依赖插件）
export function adjust(rgb, { brightness = 0, contrast = 0, saturation = 1 }) {
  let [h, s, l] = rgbToHsl(rgb);
  if (brightness) l = Math.max(0, Math.min(1, l + brightness));
  if (contrast) l = Math.max(0, Math.min(1, (l - 0.5) * (1 + contrast) + 0.5));
  if (saturation !== 1) s = Math.max(0, Math.min(1, s * saturation));
  return hslToRgb([h, s, l]);
}

// k-means++，在 Lab 空间聚类
export function kmeansLab(points, k, iters = 40) {
  if (points.length <= k) {
    return points.map((p) => ({ center: p.slice(), members: [p] }));
  }
  const centers = [points[Math.floor(points.length / 2)].slice()];
  while (centers.length < k) {
    let best = null, bestD = -1;
    for (const p of points) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, deltaE(p, c));
      if (d > bestD) { bestD = d; best = p; }
    }
    centers.push(best.slice());
  }

  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = deltaE(points[i], centers[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]], p = points[i];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (sums[c][3] === 0) continue;
      const s = sums[c];
      centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
    if (!moved && it > 2) break;
  }

  return centers.map((center, c) => ({
    center,
    members: assign.map((a, i) => (a === c ? i : -1)).filter((i) => i >= 0),
  }));
}

// 清理孤立碎点：level 1 只改无同色邻居的单格；level 2+ 允许 4 邻域多数色替换
export function despeckle(grid, W, H, level = 1) {
  if (level <= 0) return grid;
  const out = Int16Array.from(grid);
  const rounds = level >= 3 ? 3 : level;
  for (let r = 0; r < rounds; r++) {
    const snapshot = Int16Array.from(out);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const cur = snapshot[i];
        if (cur < 0) continue;
        const nb = [];
        if (x > 0) nb.push(snapshot[i - 1]);
        if (x < W - 1) nb.push(snapshot[i + 1]);
        if (y > 0) nb.push(snapshot[i - W]);
        if (y < H - 1) nb.push(snapshot[i + W]);
        const same = nb.filter((v) => v === cur).length;
        if (same >= 2) continue;
        const tally = new Map();
        for (const v of nb) {
          if (v < 0) continue;
          tally.set(v, (tally.get(v) || 0) + 1);
        }
        let bestV = -1, bestC = 0;
        for (const [v, c] of tally) {
          if (c > bestC || (c === bestC && v > bestV)) { bestC = c; bestV = v; }
        }
        if (bestC >= (level >= 2 ? 2 : 3)) out[i] = bestV;
      }
    }
  }
  return out;
}

// 稀有色替换：把颗数过少的色换成视觉最接近的其它色，避免为 1~2 颗专门买一包
export function dropRare(grid, W, H, palette, minCount) {
  if (!minCount || minCount < 2) return grid;
  let out = Int16Array.from(grid);
  for (let pass = 0; pass < 6; pass++) {
    const counts = countColors(out, palette.length);
    const rare = [];
    for (let i = 0; i < palette.length; i++) if (counts[i] > 0 && counts[i] < minCount) rare.push(i);
    if (!rare.length) break;
    let changed = false;
    const labs = palette.map((c) => rgbToLab(hexToRgb(c.hex)));
    for (const r of rare) {
      const kept = [];
      for (let i = 0; i < palette.length; i++) {
        if (i !== r && counts[i] > 0) kept.push(i);
      }
      if (!kept.length) break;
      let best = kept[0], bd = Infinity;
      for (const k of kept) {
        const d = deltaE(labs[r], labs[k]);
        if (d < bd) { bd = d; best = k; }
      }
      for (let i = 0; i < out.length; i++) if (out[i] === r) out[i] = best;
      counts[r] = 0; counts[best] += 1;
      changed = true;
    }
    if (!changed) break;
  }
  return out;
}

// 在原图分辨率上抠掉背景（把背景像素设为透明）。
// 必须在缩放之前做：勾边线往往只有 1~3 像素宽，缩到 45 格后会被插值抹掉，
// 导致"背景水流"顺着缝隙流进人物内部。
export function cutOutBackground(img, { colors = 4, threshold = 26, lightness = 45, sat = 0.42, ring = 2, maxDepth = 0, keep = null, centers: presetCenters = null } = {}) {
  const { width: W, height: H } = img.bitmap;
  const data = img.bitmap.data;
  const n = W * H;
  // 背景色优先用调用方给的（从「未裁剪原图」采的）——裁剪后图像最外圈往往已经是人物，
  // 从那里采样会把头发当背景色，分割必然出错。
  let centers = presetCenters;
  if (!centers || !centers.length) {
    const border = [];
    const at = (x, y) => [data[(y * W + x) * 4], data[(y * W + x) * 4 + 1], data[(y * W + x) * 4 + 2]];
    for (let x = 0; x < W; x++) for (let r = 0; r < ring; r++) border.push(at(x, r), at(x, H - 1 - r));
    for (let y = 0; y < H; y++) for (let r = 0; r < ring; r++) border.push(at(r, y), at(W - 1 - r, y));
    centers = kmeansLab(border.map(rgbToLab), colors).map((c) => c.center);
  }

  const t2 = threshold * threshold;
  // state: 0 = 不可通行 | 1 = 可通行且删除 | 2 = 可通行但受保护(keep 内)
  // keep 区只是"不删除"，水流仍能穿过它去删别处的背景 —— 这样脸保住了，背景又能清干净。
  const state = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = i % W, y = (i - x) / W;
    const c = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    const lab = rgbToLab(c);
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    if (lab[0] <= lightness && (mx - mn) / 255 <= sat) continue;   // 勾线不可通行
    let bd = Infinity;
    for (const cc of centers) { const d = deltaE(lab, cc); if (d < bd) bd = d; }
    if (bd > t2) continue;
    const inKeep = keep && x >= keep.x && y >= keep.y && x < keep.x + keep.w && y < keep.y + keep.h;
    state[i] = inKeep ? 2 : 1;
  }

  // maxDepth：背景水流最多往里走多少像素。
  // 限制深度能保护画面中央的主体（脸颊边缘这类"和背景同色又直接相邻"的区域不会被啃掉），
  // 同时四周的浅色背景照常删掉。
  const depthLimit = maxDepth > 0 ? maxDepth : Math.round(Math.min(W, H) * 0.34);
  const reached = new Uint8Array(n);
  const depth = new Int32Array(n);
  const stack = [];
  const push = (i, d) => { if (!state[i] || reached[i] || d > depthLimit) return; reached[i] = 1; depth[i] = d; stack.push(i); };
  for (let x = 0; x < W; x++) { push(x, 0); push((H - 1) * W + x, 0); }
  for (let y = 0; y < H; y++) { push(y * W, 0); push(y * W + W - 1, 0); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i - x) / W;
    const d = depth[i] + 1;
    if (x > 0) push(i - 1, d);
    if (x < W - 1) push(i + 1, d);
    if (y > 0) push(i - W, d);
    if (y < H - 1) push(i + W, d);
  }
  let removed = 0;
  for (let i = 0; i < n; i++) if (reached[i] && state[i] === 1) { data[i * 4 + 3] = 0; removed++; }
  return { removed, total: n };
}

export function countColors(grid, n) {
  const counts = new Array(n).fill(0);
  for (let i = 0; i < grid.length; i++) if (grid[i] >= 0) counts[grid[i]]++;
  return counts;
}

// 描边遮罩：找"又暗又不艳"的像素（黑/深棕勾线）。
// 抠图时背景水流碰到这些线就停，因此线内的人物（哪怕颜色和背景接近）不会被误删。
export function findOutlineMask(rgbOf, W, H, { lightness = 45, sat = 0.42 } = {}) {
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const c = rgbOf[i];
    if (!c) continue;
    const lab = rgbToLab(c);
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    if (lab[0] <= lightness && (mx - mn) / 255 <= sat) mask[i] = 1;
  }
  return mask;
}

// 背景去纹理：把「从画面边缘连通进来」的背景色块压平成纯色。
// 只从边界做 BFS，因此主体内部同色的区域（被轮廓线包住）不会被误伤。
export function flattenBackground(grid, W, H, candLabs, borderLabs, { colors = 2, threshold = 14, mode = 'global', bgTargets = null, blank = false, outline = null } = {}) {
  const k = Math.max(1, Math.min(6, colors | 0));
  // bgTargets：调用方指定的背景色（在 candLabs 中的下标），保证背景用的是色卡里最合适的色号
  const centers = bgTargets && bgTargets.length
    ? bgTargets.map((i) => candLabs[i])
    : kmeansLab(borderLabs, k).map((c) => c.center);
  const n = W * H;
  const t2 = threshold * threshold;
  const isBg = new Uint8Array(n);
  const assign = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (grid[i] < 0) continue;
    if (outline && outline[i]) continue;   // 勾线本身不算背景
    const lab = candLabs[grid[i]];
    let bi = -1, bd = Infinity;
    for (let c = 0; c < centers.length; c++) {
      const d = deltaE(lab, centers[c]);
      if (d < bd) { bd = d; bi = c; }
    }
    if (bi >= 0 && bd <= t2) { isBg[i] = 1; assign[i] = bi; }
  }

  const reached = new Uint8Array(n);
  const stack = [];
  if (mode !== 'global') {
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (!isBg[i] || reached[i]) return;
      reached[i] = 1;
      stack.push(i);
    };
    for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
    for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
    while (stack.length) {
      const i = stack.pop();
      const x = i % W, y = (i - x) / W;
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
    }
  } else {
    for (let i = 0; i < n; i++) if (isBg[i]) reached[i] = 1;
  }

  const map = bgTargets && bgTargets.length
    ? bgTargets
    : centers.map((c) => {
      let best = 0, bd = Infinity;
      candLabs.forEach((lab, i) => {
        const d = deltaE(c, lab);
        if (d < bd) { bd = d; best = i; }
      });
      return best;
    });
  const out = Int16Array.from(grid);
  // blank: 背景格子留空（不放豆），拼的时候跳过，省豆子
  if (blank) {
    for (let i = 0; i < n; i++) if (reached[i]) out[i] = -1;
  } else {
    for (let i = 0; i < n; i++) if (reached[i]) out[i] = map[assign[i]];
  }
  return out;
}