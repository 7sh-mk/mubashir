import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// Thresholds for step 1. Will move to config.js once checks.js exists.
const CONFIG = {
  wasmUrl: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  modelUrl:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",

  // Guide oval, relative to the visible camera area.
  guide: {
    centerY: 0.45,      // oval center, fraction of stage height
    heightRatio: 0.62,  // oval height, fraction of stage height
    maxWidthRatio: 0.82, // oval width never exceeds this fraction of stage width
    aspect: 0.74,       // width / height
  },

  // Forehead (landmark 10) to chin (152), as a fraction of the oval height.
  distance: { min: 0.6, max: 0.86 },

  // Face center offset from the target point, as a fraction of the oval size.
  center: { maxX: 0.14, maxY: 0.12, targetOffsetY: 0.1 },

  // Eye-line roll in degrees.
  tiltMaxDeg: 5,

  smoothing: 0.35,    // EMA factor for measurements (0..1, higher = faster)
  messageHoldMs: 350, // a new message must persist this long before it shows
};

const MSG = {
  loading: "جارٍ التحميل…",
  noFace: "لم يُكتشف وجه، يُرجى النظر إلى الكاميرا",
  tooFar: "اقترب قليلًا",
  tooClose: "ابتعد قليلًا",
  moveLeft: "حرّك الجوال إلى اليسار قليلًا",
  moveRight: "حرّك الجوال إلى اليمين قليلًا",
  moveUp: "ارفع الجوال قليلًا",
  moveDown: "اخفض الجوال قليلًا",
  tilt: "حافظ على استقامة رأسك",
  ok: "ممتاز، حافظ على هذه الوضعية",
  cameraError: "تعذّر تشغيل الكاميرا، يُرجى السماح بالوصول إليها ثم تحديث الصفحة",
  modelError: "حدث خطأ أثناء التحميل، يُرجى التحقق من الاتصال بالإنترنت ثم تحديث الصفحة",
};

// Landmark indices (MediaPipe Face Mesh).
const LM = { forehead: 10, chin: 152, rightEyeOuter: 33, leftEyeOuter: 263 };

const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const msgEl = document.getElementById("msg");
const startEl = document.getElementById("start");
const startBtn = document.getElementById("startBtn");

let landmarker = null;
let lastVideoTime = -1;
let smooth = null;
let shown = { key: null };
let pending = { key: null, since: 0 };

// ---------- setup ----------

async function loadModel() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.wasmUrl);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: CONFIG.modelUrl, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    return await FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
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

function measure(landmarks, w, h) {
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
  };
}

function ema(prev, next, a) {
  if (!prev) return { ...next };
  const out = {};
  for (const k in next) out[k] = prev[k] + a * (next[k] - prev[k]);
  return out;
}

// ---------- guidance (highest priority first) ----------

function evaluate(m, oval) {
  const ratio = m.faceH / (oval.ry * 2);
  if (ratio < CONFIG.distance.min) return "tooFar";
  if (ratio > CONFIG.distance.max) return "tooClose";

  const dx = (m.cx - oval.cx) / (oval.rx * 2);
  const dy = (m.cy - (oval.cy + oval.ry * CONFIG.center.targetOffsetY)) / (oval.ry * 2);
  // Selfie view: moving the phone left shifts the face right on screen.
  if (dx < -CONFIG.center.maxX) return "moveLeft";
  if (dx > CONFIG.center.maxX) return "moveRight";
  // Raising the phone shifts the face down on screen.
  if (dy < -CONFIG.center.maxY) return "moveUp";
  if (dy > CONFIG.center.maxY) return "moveDown";

  if (Math.abs(m.rollDeg) > CONFIG.tiltMaxDeg) return "tilt";

  return "ok";
}

function showMessage(key, now) {
  if (key !== pending.key) {
    pending = { key, since: now };
  }
  const immediate = shown.key === null;
  if (key !== shown.key && (immediate || now - pending.since >= CONFIG.messageHoldMs)) {
    shown.key = key;
    msgEl.textContent = MSG[key];
    msgEl.className = "msg " + (key === "ok" ? "ok" : "warn");
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

// ---------- loop ----------

function loop() {
  const { width: w, height: h } = canvas.getBoundingClientRect();
  const oval = guideOval(w, h);
  const now = performance.now();

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, now);
    const face = result.faceLandmarks?.[0];

    if (face) {
      smooth = ema(smooth, measure(face, w, h), CONFIG.smoothing);
      showMessage(evaluate(smooth, oval), now);
    } else {
      smooth = null;
      showMessage("noFace", now);
    }
  }

  drawOverlay(w, h, oval, shown.key === "ok");
  requestAnimationFrame(loop);
}

// ---------- boot ----------

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

loadModel()
  .then((lm) => {
    landmarker = lm;
    startBtn.disabled = false;
    startBtn.textContent = "ابدأ";
  })
  .catch((err) => {
    console.error(err);
    startBtn.textContent = MSG.modelError;
  });

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    msgEl.textContent = MSG.cameraError;
    msgEl.className = "msg warn";
    return;
  }
  startEl.hidden = true;
  resizeCanvas();
  requestAnimationFrame(loop);
});
