// Turns a captured frame into the final photo: white background, 4x6 crop, JPG.
import { LM } from "./checks.js";

/**
 * frame: canvas with the full, unmirrored camera frame.
 * bg: Float32Array background confidence (0..1), mw x mh, for the same frame.
 * face: normalized landmarks for the same frame.
 * out: CONFIG.output.
 * Returns a canvas of out.width x out.height.
 */
export function buildPhoto(frame, bg, mw, mh, face, out) {
  const W = frame.width;
  const H = frame.height;

  // 1. Soft person mask at segmenter resolution.
  const mask = document.createElement("canvas");
  mask.width = mw;
  mask.height = mh;
  const mctx = mask.getContext("2d");
  const img = mctx.createImageData(mw, mh);
  const span = out.maskHigh - out.maskLow;
  for (let i = 0; i < bg.length; i++) {
    const a = Math.min(1, Math.max(0, (1 - bg[i] - out.maskLow) / span));
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  mctx.putImageData(img, 0, 0);

  // 2. Cut the person out of the frame using the upscaled, feathered mask.
  const person = document.createElement("canvas");
  person.width = W;
  person.height = H;
  const pctx = person.getContext("2d");
  pctx.drawImage(frame, 0, 0);
  pctx.globalCompositeOperation = "destination-in";
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  pctx.filter = `blur(${(out.featherPx * W) / mw}px)`;
  pctx.drawImage(mask, 0, 0, W, H);
  pctx.filter = "none";
  pctx.globalCompositeOperation = "source-over";

  // 3. Head box: crown from the mask above the face center, chin from landmarks.
  const cxN = (face[LM.rightCheek].x + face[LM.leftCheek].x) / 2;
  const crownY = findCrown(img.data, mw, mh, cxN, face[LM.forehead].y) * H;
  const chinY = face[LM.chin].y * H;
  const headH = Math.max(1, chinY - crownY);

  const cropH = headH / out.headRatio;
  const cropW = (cropH * out.width) / out.height;
  const cropX = cxN * W - cropW / 2;
  const cropY = crownY - cropH * out.topMargin;

  // 4. Crop and scale down in steps (less noise and aliasing than one big jump).
  const layer = scaleDown(person, cropX, cropY, cropW, cropH, out.width, out.height);

  // 5. Clean up the person: auto levels / white balance, then a light sharpen.
  enhance(layer, out.enhance);

  // 6. Compose onto pure white.
  const result = document.createElement("canvas");
  result.width = out.width;
  result.height = out.height;
  const rctx = result.getContext("2d");
  rctx.fillStyle = "#ffffff";
  rctx.fillRect(0, 0, out.width, out.height);
  rctx.drawImage(layer, 0, 0);
  return result;
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Crops (sx, sy, sw, sh) from src and halves it repeatedly until close to dw x dh.
// Areas outside src stay transparent, so they end up white.
function scaleDown(src, sx, sy, sw, sh, dw, dh) {
  let cur = canvasOf(sw, sh);
  cur.getContext("2d").drawImage(src, -sx, -sy);
  while (cur.width / 2 >= dw && cur.height / 2 >= dh) {
    const half = canvasOf(cur.width / 2, cur.height / 2);
    const hctx = half.getContext("2d");
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const dst = canvasOf(dw, dh);
  const dctx = dst.getContext("2d");
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(cur, 0, 0, dw, dh);
  return dst;
}

// Auto levels on the solid person pixels (contrast only, brightness kept),
// blended in at cfg.levels, followed by an unsharp mask.
function enhance(layer, cfg) {
  const w = layer.width;
  const h = layer.height;
  const lctx = layer.getContext("2d", { willReadFrequently: true });
  const img = lctx.getImageData(0, 0, w, h);
  const d = img.data;

  // One curve for all channels (from luma), so strong colors like a red shemagh
  // never shift the skin tone.
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
    count++;
  }
  if (count > 100 && cfg.levels > 0) {
    let lo = 0;
    let hi = 255;
    for (let acc = 0, v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= count * cfg.clipLow) { lo = v; break; }
    }
    for (let acc = 0, v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= count * (1 - cfg.clipHigh)) { hi = v; break; }
    }
    const gain = Math.min(cfg.maxGain, 255 / Math.max(1, hi - lo));
    const curve = new Float32Array(256);
    for (let v = 0; v < 256; v++) curve[v] = v + cfg.levels * ((v - lo) * gain - v);

    // Keep overall brightness: a gamma that maps the new median luma back to the old one.
    let median = 128;
    for (let acc = 0, v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= count / 2) { median = v; break; }
    }
    const moved = Math.min(254, Math.max(1, curve[median]));
    const gamma = median > 0 ? Math.log(median / 255) / Math.log(moved / 255) : 1;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = 255 * Math.pow(Math.min(1, Math.max(0, curve[v] / 255)), gamma);
    }

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }

  if (cfg.sharpen > 0) {
    lctx.putImageData(img, 0, 0);
    const blur = canvasOf(w, h);
    const bctx = blur.getContext("2d", { willReadFrequently: true });
    bctx.filter = `blur(${cfg.sharpenRadius}px)`;
    bctx.drawImage(layer, 0, 0);
    const b = bctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] += cfg.sharpen * (d[i] - b[i]);
      d[i + 1] += cfg.sharpen * (d[i + 1] - b[i + 1]);
      d[i + 2] += cfg.sharpen * (d[i + 2] - b[i + 2]);
    }
  }
  lctx.putImageData(img, 0, 0);
}

// Topmost row (normalized) where the person mask is solid, scanning a narrow
// band around the face center. Falls back to a guess above the forehead.
function findCrown(data, mw, mh, cxN, foreheadN) {
  const cx = Math.round(cxN * mw);
  const half = Math.max(1, Math.round(mw * 0.02));
  const limit = Math.round(foreheadN * mh);
  for (let y = 0; y < limit; y++) {
    let solid = 0;
    for (let x = cx - half; x <= cx + half; x++) {
      if (x >= 0 && x < mw && data[(y * mw + x) * 4 + 3] > 128) solid++;
    }
    if (solid > half) return y / mh;
  }
  return Math.max(0, foreheadN - 0.08);
}

export function toJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", quality);
  });
}
