// Document scans: guess the page's four corners, let the user nudge them, and warp the photo flat.
(function () {
  // Guess corners: the page is usually the biggest bright blob on a darker desk. Threshold (Otsu), take the
  // largest connected bright region, and read its four extreme corners. Returns corners in 0..1 of the image.
  function detectCorners(bmp) {
    const max = 360, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(8, Math.round(bmp.width * scale)), h = Math.max(8, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h); const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; g[j] = v; hist[v]++; }
    // Otsu threshold
    const total = w * h; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; } }
    const bright = new Uint8Array(w * h); for (let i = 0; i < g.length; i++) bright[i] = g[i] > thr ? 1 : 0;
    // Largest connected bright component (4-neighbour flood fill, iterative)
    const label = new Int32Array(w * h).fill(-1); let bestSize = 0, bestId = -1, id = 0; const stack = [];
    const comps = [];
    for (let s = 0; s < w * h; s++) {
      if (!bright[s] || label[s] >= 0) continue;
      let size = 0; stack.push(s); label[s] = id;
      while (stack.length) { const p = stack.pop(); size++; const x = p % w, y = (p / w) | 0; const nb = [p - 1, p + 1, p - w, p + w]; const ok = [x > 0, x < w - 1, y > 0, y < h - 1]; for (let k = 0; k < 4; k++) { const q = nb[k]; if (ok[k] && bright[q] && label[q] < 0) { label[q] = id; stack.push(q); } } }
      comps[id] = size; if (size > bestSize) { bestSize = size; bestId = id; }
      id++;
    }
    if (bestId < 0 || bestSize < total * 0.12) return null;
    // Extreme corners of that component
    let tl = null, tr = null, br = null, bl = null, vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = Infinity;
    for (let p = 0; p < w * h; p++) {
      if (label[p] !== bestId) continue;
      const x = p % w, y = (p / w) | 0;
      if (x + y < vtl) { vtl = x + y; tl = [x, y]; }
      if (x - y > vtr) { vtr = x - y; tr = [x, y]; }
      if (x + y > vbr) { vbr = x + y; br = [x, y]; }
      if (x - y < vbl) { vbl = x - y; bl = [x, y]; }
    }
    const quad = [tl, tr, br, bl].map(([x, y]) => [x / (w - 1), y / (h - 1)]);
    // Sanity: a sensible page quad is convex-ish and covers a decent area; otherwise fall back.
    const area = Math.abs((quad[0][0] * quad[1][1] - quad[1][0] * quad[0][1]) + (quad[1][0] * quad[2][1] - quad[2][0] * quad[1][1]) + (quad[2][0] * quad[3][1] - quad[3][0] * quad[2][1]) + (quad[3][0] * quad[0][1] - quad[0][0] * quad[3][1])) / 2;
    if (area < 0.15) return null;
    return quad;
  }

  // Homography mapping the unit square (dest) to the source quad; returns 3x3 as a flat array.
  function homography(src) {
    // src: 4 points [[x,y]...] in source px for dest corners (0,0),(1,0),(1,1),(0,1)
    const [p0, p1, p2, p3] = src;
    const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dx3 = p0[0] - p1[0] + p2[0] - p3[0];
    const dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1], dy3 = p0[1] - p1[1] + p2[1] - p3[1];
    let a13, a23;
    if (dx3 === 0 && dy3 === 0) { a13 = 0; a23 = 0; }
    else { const den = dx1 * dy2 - dx2 * dy1 || 1e-9; a13 = (dx3 * dy2 - dx2 * dy3) / den; a23 = (dx1 * dy3 - dx3 * dy1) / den; }
    const a11 = p1[0] - p0[0] + a13 * p1[0], a21 = p1[1] - p0[1] + a13 * p1[1];
    const a12 = p3[0] - p0[0] + a23 * p3[0], a22 = p3[1] - p0[1] + a23 * p3[1];
    return [a11, a12, p0[0], a21, a22, p0[1], a13, a23, 1];
  }

  // Warp the quad (corners in 0..1, order TL TR BR BL) to a flat rectangle. Returns a canvas.
  function warp(bmp, corners, maxSide) {
    const W = bmp.width, H = bmp.height;
    const src = corners.map(([x, y]) => [x * W, y * H]);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let outW = Math.round((dist(src[0], src[1]) + dist(src[3], src[2])) / 2);
    let outH = Math.round((dist(src[0], src[3]) + dist(src[1], src[2])) / 2);
    const lim = maxSide || 2000; const sc = Math.min(1, lim / Math.max(outW, outH)); outW = Math.max(8, Math.round(outW * sc)); outH = Math.max(8, Math.round(outH * sc));
    const sc2 = document.createElement('canvas'); sc2.width = W; sc2.height = H; const sctx = sc2.getContext('2d'); sctx.drawImage(bmp, 0, 0);
    const sd = sctx.getImageData(0, 0, W, H).data;
    const out = document.createElement('canvas'); out.width = outW; out.height = outH; const octx = out.getContext('2d');
    const od = octx.createImageData(outW, outH); const o = od.data;
    const [a11, a12, a13, a21, a22, a23, a31, a32] = homography(src);
    for (let y = 0; y < outH; y++) {
      const v = (y + 0.5) / outH;
      for (let x = 0; x < outW; x++) {
        const u = (x + 0.5) / outW;
        const den = a31 * u + a32 * v + 1;
        let sx = (a11 * u + a12 * v + a13) / den, sy = (a21 * u + a22 * v + a23) / den;
        if (sx < 0) sx = 0; if (sy < 0) sy = 0; if (sx > W - 1.001) sx = W - 1.001; if (sy > H - 1.001) sy = H - 1.001;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
        const oi = (y * outW + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx, bot = sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx;
          o[oi + ch] = top * (1 - fy) + bot * fy;
        }
        o[oi + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  window.NCScan = { detectCorners, warp };
})();
