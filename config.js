// Every requirement and threshold lives here. Tune values here, not in the checks.

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

export const CONFIG = {
  mediapipeUrl: `${MP}/vision_bundle.mjs`,
  wasmUrl: `${MP}/wasm`,
  faceModelUrl:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  segmenterModelUrl:
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",

  // Guide oval, relative to the visible camera area.
  guide: {
    centerY: 0.45,       // oval center, fraction of stage height
    heightRatio: 0.62,   // oval height, fraction of stage height
    maxWidthRatio: 0.82, // oval width never exceeds this fraction of stage width
    aspect: 0.74,        // width / height
  },

  // Forehead (landmark 10) to chin (152), as a fraction of the oval height.
  distance: { min: 0.6, max: 0.86 },

  // Face center offset from the target point, as a fraction of the oval size.
  center: { maxX: 0.14, maxY: 0.12, targetOffsetY: 0.1 },

  // Eye-line roll in degrees.
  tiltMaxDeg: 5,

  // Head facing the camera, from the face transformation matrix (degrees).
  pose: { maxYawDeg: 8, maxPitchDeg: 12 },

  // Gaze, from eyeLook* blendshapes (0..1). Looking down gets more room because
  // people naturally look at the screen just below the camera.
  gaze: { maxSide: 0.25, maxUp: 0.35, maxDown: 0.6 }, // Absher samples: straight 0.08 side, looking away 0.31

  // Face brightness (0-255 luma), sampled from the face box.
  light: {
    sampleSize: 48,       // the face box is downscaled to this many pixels square
    minMean: 75,          // darker than this: too dark
    maxMean: 205,         // brighter than this: too bright
    clipLevel: 245,       // a pixel at or above this counts as blown out
    maxClippedRatio: 0.2, // more blown-out pixels than this: too bright
    maxSideDiff: 0.18,    // brightness gap between the two cheeks (share of the brighter one)
  },

  // Head cover and face visibility, from the multiclass segmentation mask.
  cover: {
    everyNthFrame: 3,      // run the segmenter on every Nth analysed frame
    maxHairWomen: 0.2,     // hair share above the brows; more means hair is showing
    minCoverMen: 0.35,     // ghutra/shemagh (clothes/accessory) share above the brows
    minForehead: 0.18,     // visible forehead skin above the brows, as a share of brows-to-chin (accepted sample: 0.27, covered: 0.11)
    minFaceSkin: 0.7,      // visible skin in the more covered half of the face (below the brows)
    minChin: 0.85,         // visible skin just above the chin edge (accepted samples: 1.0)
    maxEarsWomen: 0.2,     // skin beside the face at ear height (ears showing)
    maxLooseWomen: 0.35,   // background or hair right beside the face (hijab not snug)
    maxNeckWomen: 0.12,    // body skin under the chin (neck showing)
    maxHands: 0.04,        // body skin around the head and shoulders, per face area
    smoothing: 0.4,        // EMA factor for these ratios
  },

  // Camera quality. Low resolution or a blurry face shows a "use another device" notice.
  quality: {
    minShortSide: 720, // video short side in pixels (720p)
    sharpHeight: 160,  // face region is rescaled to this height before measuring
    minSharpness: 40,  // variance of the Laplacian; lower means blurry or smeared
    sampleEvery: 5,    // measure sharpness every Nth analysed frame
    window: 24,        // samples to collect before judging (about 2 seconds)
  },

  // Output: Saudi Civil Affairs photo, 4x6 cm at 300 DPI, white background.
  // The source does not specify head height or eye position: ICAO-style defaults.
  output: {
    width: 472,
    height: 709,
    quality: 0.92,
    filename: "sura-ahwal.jpg",
    mirror: true,     // save the photo as seen in the live (selfie) preview
    headRatio: 0.75,  // crown to chin, as a share of photo height
    topMargin: 0.08,  // space above the crown, as a share of photo height
    maskLow: 0.3,     // person confidence below this is fully background
    maskHigh: 0.7,    // above this is fully person; in between is a soft edge
    featherPx: 1.5,   // blur on the mask edge, in mask pixels
    // Clean-up applied to the person only; the background stays pure white.
    enhance: {
      levels: 0.5,       // 0..1 strength of auto levels (contrast only; hue and brightness kept)
      clipLow: 0.01,     // ignore the darkest 1% when finding the black point
      clipHigh: 0.99,    // ignore the brightest 1% when finding the white point
      maxGain: 1.3,      // never stretch a channel more than this
      sharpen: 0.35,     // unsharp-mask amount (0 = off)
      sharpenRadius: 1,  // blur radius for the unsharp mask, in output pixels
    },
  },

  smoothing: 0.35,    // EMA factor for face measurements (0..1, higher = faster)
  messageHoldMs: 350, // a new message must persist this long before it shows
};

// Guidance text: [male, female]. A plain string is the same for both.
export const MSG = {
  loading: "جارٍ التحميل…",
  noFace: "لم يُكتشف وجه، يُرجى النظر إلى الكاميرا",
  tooFar: ["اقترب قليلًا", "اقتربي قليلًا"],
  tooClose: ["ابتعد قليلًا", "ابتعدي قليلًا"],
  moveLeft: ["حرّك الجوال إلى اليسار قليلًا", "حرّكي الجوال إلى اليسار قليلًا"],
  moveRight: ["حرّك الجوال إلى اليمين قليلًا", "حرّكي الجوال إلى اليمين قليلًا"],
  moveUp: ["ارفع الجوال قليلًا", "ارفعي الجوال قليلًا"],
  moveDown: ["اخفض الجوال قليلًا", "اخفضي الجوال قليلًا"],
  tilt: ["حافظ على استقامة رأسك", "حافظي على استقامة رأسك"],
  faceForward: ["اجعل وجهك مقابلًا للكاميرا مباشرة", "اجعلي وجهك مقابلًا للكاميرا مباشرة"],
  lookAhead: ["انظر إلى الأمام نحو الكاميرا مباشرة", "انظري إلى الأمام نحو الكاميرا مباشرة"],
  faceCovered: ["الشماغ يغطي جزءًا من وجهك، اكشف الوجه كاملًا", "الحجاب يغطي جزءًا من وجهك، اكشفي الوجه كاملًا"],
  noGhutra: "ارتدِ الغترة أو الشماغ",
  hairShowing: "غطّي الشعر بالحجاب",
  earsShowing: "غطّي أذنيكِ بالحجاب",
  hijabLoose: "شدّي الحجاب حول الوجه",
  neckShowing: "غطّي الرقبة بالحجاب",
  chinCovered: ["اكشف الذقن كاملًا", "الحجاب يغطي الذقن، اكشفي الذقن كاملًا"],
  handsVisible: ["أبعد يدك عن الصورة", "أبعدي يدك عن الصورة"],
  foreheadCovered: "ارفعي الحجاب عن جبهتك",
  tooDark: ["الإضاءة ضعيفة، اقترب من مصدر الضوء", "الإضاءة ضعيفة، اقتربي من مصدر الضوء"],
  shadowRight: [
    "يوجد ظل على الجانب الأيمن من وجهك، اجعل مصدر الضوء أمامك مباشرة",
    "يوجد ظل على الجانب الأيمن من وجهك، اجعلي مصدر الضوء أمامك مباشرة",
  ],
  shadowLeft: [
    "يوجد ظل على الجانب الأيسر من وجهك، اجعل مصدر الضوء أمامك مباشرة",
    "يوجد ظل على الجانب الأيسر من وجهك، اجعلي مصدر الضوء أمامك مباشرة",
  ],
  tooBright: ["الإضاءة قوية، ابتعد عن مصدر الضوء", "الإضاءة قوية، ابتعدي عن مصدر الضوء"],
  ok: ["الوضعية صحيحة، اضغط «التقاط» عندما تكون مستعدًا", "الوضعية صحيحة، اضغطي «التقاط» عندما تكونين مستعدة"],
  processing: "جارٍ تجهيز الصورة…",
  ready: "الصورة جاهزة بمقاس 4×6 سم وخلفية بيضاء",
  processError: "تعذّر تجهيز الصورة، يُرجى إعادة التصوير",
  cameraError: "تعذّر تشغيل الكاميرا، يُرجى السماح بالوصول إليها ثم تحديث الصفحة",
  modelError: "حدث خطأ أثناء التحميل، يُرجى التحقق من الاتصال بالإنترنت ثم تحديث الصفحة",
};

export function msg(key, gender) {
  const m = MSG[key];
  return Array.isArray(m) ? m[gender === "f" ? 1 : 0] : m;
}
