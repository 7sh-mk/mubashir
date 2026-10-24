import { CONFIG, msg } from "./config.js";
import { LM, analyzeHead, evaluate, headPose, gazeFrom } from "./checks.js";
import { buildPhoto, toJpegBlob } from "./export.js";


const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const msgEl = $("msg");
const startEl = $("start");
const startStatus = $("startStatus");
const genderBtns = [...document.querySelectorAll("[data-gender]")];
const captureBtn = $("captureBtn");
const previewEl = $("preview");
const shotImg = $("shot");
const retakeBtn = $("retakeBtn");
const downloadBtn = $("downloadBtn");
const qualityEl = $("quality");
const qualityClose = $("qualityClose");
const debug = new URLSearchParams(location.search).has("debug");

// Small offscreen canvases for sampling the face.
const lightCanvas = document.createElement("canvas");
lightCanvas.width = lightCanvas.height = CONFIG.light.sampleSize;
const lightCtx = lightCanvas.getContext("2d", { willReadFrequently: true });
const sharpCanvas = document.createElement("canvas");
const sharpCtx = sharpCanvas.getContext("2d", { willReadFrequently: true });

let gender = "m";
let landmarker = null;
let segmenter = null;
let loadPct = 0; // download progress of the model being fetched, 0..100
let lastVideoTime = -1;
let analysed = 0;
let smooth = null;
let head = null;
let shown = { key: null };
let pending = { key: null, since: 0 };
let captured = false;
let photoUrl = null;
let sharpSamples = [];
let qualityWarned = false;
let lastSharpness = null;

// ---------- setup ----------

async function withFallback(create) {
  try {
    return await create("GPU");
  } catch {
    return await create("CPU");
  }
}

// Fetches a model file with progress, keeping a copy in the Cache API so later
// visits load it instantly (the model hosts only allow an hour of HTTP caching).
async function fetchModel(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CONFIG.modelCache);
    const hit = await cache.match(url);
    if (hit) {
      onProgress(100);
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    cache = null; // Cache API unavailable (private mode, old browser): just download.
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("model download failed: " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(Math.round((received / total) * 100));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  onProgress(100);
  if (cache) cache.put(url, new Response(bytes.slice())).catch(() => {});
  return bytes;
}

// Loads the face model first (guidance can start), then the segmenter in the
// background (head-cover checks and the white background need it).
async function loadModels() {
  const progress = (pct) => {
    loadPct = pct;
    if (!startStatus.hidden) startStatus.textContent = msg("loadingPct", gender).replace("%", pct);
  };
  const [vision, faceBytes] = await Promise.all([
    import(CONFIG.mediapipeUrl),
    fetchModel(CONFIG.faceModelUrl, progress),
  ]);
  const { FaceLandmarker, ImageSegmenter, FilesetResolver } = vision;
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.wasmUrl);
  landmarker = await withFallback((delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: faceBytes, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    }),
  );
  startStatus.hidden = true;

  const segBytes = await fetchModel(CONFIG.segmenterModelUrl, (pct) => (loadPct = pct));
  segmenter = await withFallback((delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: segBytes, delegate },
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: true,
    }),
  );
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  video.srcObject = stream;
  await video.play();
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- geometry ----------

// The oval guide in CSS pixels of the stage.
function guideOval(w, h) {
  const g = CONFIG.guide;
  let ry = (h * g.heightRatio) / 2;
  let rx = ry * g.aspect;
  const maxRx = (w * g.maxWidthRatio) / 2;
  if (rx > maxRx) {
    rx = maxRx;
    ry = rx / g.aspect;
  }
  return { cx: w / 2, cy: h * g.centerY, rx, ry };
}

// Maps a normalized landmark to stage pixels, matching object-fit: cover + mirror.
function toStage(p, w, h) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(w / vw, h / vh);
  const offX = (w - vw * scale) / 2;
  const offY = (h - vh * scale) / 2;
  return {
    x: w - (p.x * vw * scale + offX),
    y: p.y * vh * scale + offY,
  };
}

// Face bounding box in video pixels.
function faceBox(landmarks) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  return { x: x0 * vw, y: y0 * vh, w: (x1 - x0) * vw, h: (y1 - y0) * vh };
}

// Mean luma and blown-out ratio over the face box.
function faceLight(box) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sw = Math.min(vw - sx, box.w);
  const sh = Math.min(vh - sy, box.h);
  if (sw < 2 || sh < 2) return { luma: 128, clipped: 0 };

  const n = CONFIG.light.sampleSize;
  lightCtx.drawImage(video, sx, sy, sw, sh, 0, 0, n, n);
  const px = lightCtx.getImageData(0, 0, n, n).data;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    sum += y;
    if (y >= CONFIG.light.clipLevel) clipped++;
  }
  const count = px.length / 4;
  return { luma: sum / count, clipped: clipped / count };
}

// Variance of the Laplacian over the inner face, at a fixed scale.
// Sharp, clean images score high; blurry or smeared webcams score low.
function faceSharpness(box) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // Inner face only, so background edges do not inflate the score.
  const sx = Math.max(0, box.x + box.w * 0.2);
  const sy = Math.max(0, box.y + box.h * 0.2);
  const sw = Math.min(vw - sx, box.w * 0.6);
  const sh = Math.min(vh - sy, box.h * 0.7);
  if (sw < 8 || sh < 8) return null;

  const H = CONFIG.quality.sharpHeight;
  const W = Math.max(8, Math.round((H * sw) / sh));
  sharpCanvas.width = W;
  sharpCanvas.height = H;
  sharpCtx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  const px = sharpCtx.getImageData(0, 0, W, H).data;

  const g = new Float32Array(W * H);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  }
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const lap = g[i - 1] + g[i + 1] + g[i - W] + g[i + W] - 4 * g[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// Brightness balance between the cheeks: -1..1, negative when the person's right
// cheek (image left in the unmirrored frame) is darker.
function sideLight(landmarks, box) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const r = box.w * 0.08;
  const mean = (p) => {
    const sx = Math.max(0, p.x * vw - r);
    const sy = Math.max(0, p.y * vh - r);
    lightCtx.drawImage(video, sx, sy, r * 2, r * 2, 0, 0, 8, 8);
    const px = lightCtx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    return sum / 64;
  };
  const right = mean(landmarks[LM.rightCheekCenter]);
  const left = mean(landmarks[LM.leftCheekCenter]);
  return (right - left) / Math.max(1, right, left);
}

function measure(landmarks, result, w, h) {
  const top = toStage(landmarks[LM.forehead], w, h);
  const chin = toStage(landmarks[LM.chin], w, h);
  // After mirroring, the person's left eye is on the screen's left.
  const eyeL = toStage(landmarks[LM.leftEyeOuter], w, h);
  const eyeR = toStage(landmarks[LM.rightEyeOuter], w, h);

  return {
    faceH: Math.hypot(chin.x - top.x, chin.y - top.y),
    cx: (top.x + chin.x) / 2,
    cy: (top.y + chin.y) / 2,
    rollDeg: (Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x) * 180) / Math.PI,
    ...headPose(result.facialTransformationMatrixes?.[0]?.data ?? IDENTITY),
    ...gazeFrom(result.faceBlendshapes?.[0]?.categories ?? []),
    ...faceLight(faceBox(landmarks)),
    sideLight: sideLight(landmarks, faceBox(landmarks)),
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function ema(prev, next, a) {
  if (!prev) return { ...next };
  const out = {};
  for (const k in next) out[k] = prev[k] + a * (next[k] - prev[k]);
  return out;
}

// Runs the segmenter and updates the smoothed head-cover ratios.
function updateHead(face, now) {
  if (!segmenter) return;
  const result = segmenter.segmentForVideo(video, now);
  try {
    const mask = result.categoryMask;
    if (!mask) return;
    const next = analyzeHead(mask.getAsUint8Array(), mask.width, mask.height, face);
    if (next) head = ema(head, next, CONFIG.cover.smoothing);
  } finally {
    result.close();
  }
}

// ---------- camera quality ----------

function showQualityWarning() {
  if (qualityWarned) return;
  qualityWarned = true;
  qualityEl.hidden = false;
}

function checkResolution() {
  const short = Math.min(video.videoWidth, video.videoHeight);
  if (short < CONFIG.quality.minShortSide) showQualityWarning();
}

// Judge sharpness only when the face is at a usable distance.
function trackSharpness(face, m, oval) {
  const ratio = m.faceH / (oval.ry * 2);
  if (ratio < CONFIG.distance.min || ratio > CONFIG.distance.max) return;
  if (analysed % CONFIG.quality.sampleEvery !== 0) return;

  const v = faceSharpness(faceBox(face));
  if (v === null) return;
  lastSharpness = v;
  sharpSamples.push(v);
  if (sharpSamples.length < CONFIG.quality.window) return;

  const sorted = [...sharpSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median < CONFIG.quality.minSharpness) showQualityWarning();
  sharpSamples = [];
}

// ---------- messages ----------

function setMessage(text, kind) {
  msgEl.textContent = text;
  msgEl.className = "msg " + kind;
}

function showMessage(key, now) {
  if (key !== pending.key) {
    pending = { key, since: now };
  }
  const immediate = shown.key === null;
  if (key !== shown.key && (immediate || now - pending.since >= CONFIG.messageHoldMs)) {
    shown.key = key;
    setMessage(msg(key, gender), key === "ok" ? "ok" : "warn");
    captureBtn.disabled = key !== "ok";
  }
}

// ---------- drawing ----------

function drawOverlay(w, h, oval, ok) {
  ctx.clearRect(0, 0, w, h);

  // Dim everything outside the oval.
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.ellipse(oval.cx, oval.cy, oval.rx, oval.ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fill("evenodd");

  ctx.beginPath();
  ctx.ellipse(oval.cx, oval.cy, oval.rx, oval.ry, 0, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = ok ? "#2fa36b" : "rgba(255, 255, 255, 0.9)";
  ctx.stroke();
}

// Add ?debug to the URL to see the numbers used for tuning CONFIG.
function drawDebug() {
  const f = (v, d = 0) => v.toFixed(d);
  const lines = [
    [
      video.videoWidth + "×" + video.videoHeight,
      smooth && "luma " + f(smooth.luma),
      smooth && "clip " + f(smooth.clipped * 100) + "%",
      lastSharpness !== null && "sharp " + f(lastSharpness),
      smooth && "roll " + f(smooth.rollDeg, 1) + "°",
    ],
    smooth
      ? [
          "yaw " + f(smooth.yawDeg, 1) + "°",
          "pitch " + f(smooth.pitchDeg, 1) + "°",
          "gaze side " + f(smooth.gazeSide, 2),
          "up " + f(smooth.gazeUp, 2),
          "down " + f(smooth.gazeDown, 2),
        ]
      : [],
    head
      ? [
          "hair " + f(head.hair, 2),
          "cover " + f(head.cover, 2),
          "forehead " + f(head.forehead, 2),
          "faceSkin " + f(head.faceSkin, 2),
          "chin " + f(head.chin, 2),
        ]
      : [],
    head
      ? [
          "ears " + f(head.ears, 2),
          "loose " + f(head.loose, 2),
          "neck " + f(head.neck, 2),
          "hands " + f(head.hands, 3),
          smooth && "sideLight " + f(smooth.sideLight, 2),
        ]
      : [],
  ].map((parts) => parts.filter(Boolean).join("  ")).filter(Boolean);

  ctx.save();
  ctx.font = "12px monospace";
  ctx.direction = "ltr";
  ctx.textAlign = "left";
  lines.forEach((text, i) => {
    const y = 8 + i * 24;
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(8, y, ctx.measureText(text).width + 12, 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, 14, y + 15);
  });
  ctx.restore();
}

// ---------- loop ----------

function loop() {
  if (captured) return;

  const { width: w, height: h } = canvas.getBoundingClientRect();
  const oval = guideOval(w, h);
  const now = performance.now();

  if (!landmarker) {
    // Camera is on but the face model is still downloading.
    setMessage(msg("loadingPct", gender).replace("%", loadPct), "warn");
  } else if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    analysed++;
    const result = landmarker.detectForVideo(video, now);
    const face = result.faceLandmarks?.[0];

    if (face) {
      smooth = ema(smooth, measure(face, result, w, h), CONFIG.smoothing);
      if (analysed % CONFIG.cover.everyNthFrame === 0) updateHead(face, now);
      let key = evaluate(smooth, oval, head, gender, CONFIG);
      // Never allow capture before the head-cover checks have run at least once.
      if (key === "ok" && !head) key = "preparing";
      showMessage(key, now);
      if (!qualityWarned) trackSharpness(face, smooth, oval);
    } else {
      smooth = null;
      head = null;
      showMessage("noFace", now);
    }
  }

  drawOverlay(w, h, oval, shown.key === "ok");
  if (debug) drawDebug();
  requestAnimationFrame(loop);
}

function resetAnalysis() {
  shown = { key: null };
  pending = { key: null, since: 0 };
  smooth = null;
  head = null;
}

// ---------- capture and export ----------

// The full camera frame. Mirrored when CONFIG.output.mirror is on, so the photo
// faces the same way as the live preview the person just saw.
function grabFrame() {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const g = c.getContext("2d");
  if (CONFIG.output.mirror) {
    g.translate(c.width, 0);
    g.scale(-1, 1);
  }
  g.drawImage(video, 0, 0);
  return c;
}

async function capture() {
  if (captureBtn.disabled || captured) return;
  captured = true;
  captureBtn.hidden = true;
  setMessage(msg("processing", gender), "ok");

  try {
    const frame = grabFrame();
    const now = performance.now();
    const face = landmarker.detectForVideo(frame, now).faceLandmarks?.[0];
    if (!face) throw new Error("no face in captured frame");

    const seg = segmenter.segmentForVideo(frame, now + 1);
    let bg, mw, mh;
    try {
      const m = seg.confidenceMasks[0]; // category 0: background
      bg = m.getAsFloat32Array().slice();
      mw = m.width;
      mh = m.height;
    } finally {
      seg.close();
    }

    const photo = buildPhoto(frame, bg, mw, mh, face, CONFIG.output);
    const blob = await toJpegBlob(photo, CONFIG.output.quality);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = URL.createObjectURL(blob);
    shotImg.src = photoUrl;
    previewEl.hidden = false;
    setMessage(msg("ready", gender), "ok");
  } catch (err) {
    console.error(err);
    setMessage(msg("processError", gender), "warn");
    previewEl.hidden = false;
    shotImg.removeAttribute("src");
    downloadBtn.hidden = true;
  }
}

function download() {
  if (!photoUrl) return;
  const a = document.createElement("a");
  a.href = photoUrl;
  a.download = CONFIG.output.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function retake() {
  previewEl.hidden = true;
  shotImg.removeAttribute("src");
  downloadBtn.hidden = false;
  captureBtn.hidden = false;
  captureBtn.disabled = true;
  resetAnalysis();
  captured = false;
  requestAnimationFrame(loop);
}

// ---------- boot ----------

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// Buttons work right away; the models keep downloading while the camera opens.
genderBtns.forEach((b) => (b.disabled = false));
loadModels().catch((err) => {
  console.error(err);
  startStatus.hidden = false;
  startStatus.textContent = msg("modelError");
  setMessage(msg("modelError"), "warn");
});

genderBtns.forEach((btn) =>
  btn.addEventListener("click", async () => {
    gender = btn.dataset.gender;
    genderBtns.forEach((b) => (b.disabled = true));
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      genderBtns.forEach((b) => (b.disabled = false));
      setMessage(msg("cameraError"), "warn");
      return;
    }
    startEl.hidden = true;
    captureBtn.hidden = false;
    resizeCanvas();
    checkResolution();
    requestAnimationFrame(loop);
  }),
);

captureBtn.addEventListener("click", capture);
retakeBtn.addEventListener("click", retake);
downloadBtn.addEventListener("click", download);
qualityClose.addEventListener("click", () => {
  qualityEl.hidden = true;
});
