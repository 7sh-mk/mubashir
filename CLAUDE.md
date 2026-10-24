# مباشر — Mubashir ID Photo

A free, single-page web app that guides the user live (in Arabic) while they take an official Saudi Civil Affairs (الأحوال المدنية) ID photo, lets the user capture with a button once every requirement is met, removes the background, crops to size, and lets the user download a JPG ready to upload directly to Absher.

## Non-negotiables
- **No server, no API keys, no paid services.** Everything runs in the browser. Hosted on GitHub Pages.
- **Privacy:** the photo never leaves the device. No analytics, no uploads.
- **Arabic-first, RTL**, mobile-first. All UI text in formal Modern Standard Arabic (فصحى), never dialect (front camera on a phone is the main use case).
- **No print feature.** Output is a single downloadable JPG.
- Scope v1: Saudi Civil Affairs photos only (men and women).
- Keep it simple: plain HTML/CSS/JS, no framework, no build step.

## Stack
- MediaPipe Tasks Vision (`@mediapipe/tasks-vision`, loaded from jsDelivr):
  - **Face Landmarker** (478 landmarks, blendshapes, transformation matrix) for pose, gaze, eyes, mouth, distance.
  - **Image Segmenter** (selfie / multiclass) for background removal and head-cover detection.
- `getUserMedia` for the front camera, `<canvas>` for analysis, white background compositing, cropping, JPG export.
- Optional: Web Speech API (`speechSynthesis`, ar-SA) to speak guidance.

## Official requirements (source: Absher PDFs in the project "الأحوال")
- Size **4×6 cm** (export at 300 DPI → 472×709 px), **white** background, **color**, **JPG/JPEG**, taken within the last 6 months.
- Clear features, neutral expression, **mouth closed**, looking **straight** at the camera, **no tilt**.
- No glasses. No red eyes. No strong/overexposed lighting. No shadows on face or background.
- **Men:** ghutra or shemagh is required; it must not cover the basic facial features.
- **Women:** hijab covers the hair (no hair showing), forehead not covered, face fully uncovered (no niqab), no makeup, no contact lenses.
- Not specified by the source: head height, eye position, file size. Use ICAO-style defaults: head (chin to crown) ≈ 70–80% of photo height, face centered horizontally, eyes ≈ 55–60% from the bottom. Keep these in one config object so they're easy to change.

## Checks → detection → guidance message
| Check | Detection | Arabic guidance |
| --- | --- | --- |
| Gaze not straight | eyeLook* blendshapes (down gets more room: people look at the screen) | «انظر إلى الأمام نحو الكاميرا مباشرة» |
| Head turned / tilted | yaw, pitch, roll from the facial transformation matrix | «أدر وجهك قليلًا إلى اليمين/اليسار» / «حافظ على استقامة رأسك» |
| Too far / too close | face height ratio in frame | «اقترب قليلًا» / «ابتعد قليلًا» |
| Off-center | face center vs frame center | «حرّك الجوال إلى اليمين/اليسار» / «ارفع/اخفض الجوال قليلًا» |
| Eyes closed | eyeBlink blendshapes (or EAR) | «افتح عينيك» |
| Mouth open | jawOpen / mouthClose blendshapes | «أغلق فمك» |
| Overexposed | % of near-white pixels on face region | «الإضاءة قوية، ابتعد عن مصدر الضوء» |
| Too dark | mean face luminance | «الإضاءة ضعيفة، اقترب من مصدر الضوء» |
| Shadow on face | luminance difference left vs right half of face | «يوجد ظل على الجانب …، واجه مصدر الضوء» |
| Glasses | heuristic around eyes (edges/reflection); warn, don't block if unsure | «انزع النظارة» |
| Face covered (niqab) / features covered | missing/low-confidence nose & mouth landmarks | «اكشف الوجه كاملًا» |
| Forehead covered (women) | distance from brows to top of head-cover vs face height | «ارفعي الحجاب عن جبهتك» |
| Hair showing (women) | color band between forehead and hijab | «غطّي الشعر بالحجاب» |
| Ears showing (women) | skin beside the face at ear height | «غطّي أذنيكِ بالحجاب» |
| Hijab not snug (women) | background or hair in a thin band against the face edge | «شدّي الحجاب حول الوجه» |
| Neck showing (women; civil affairs requires hair and neck covered) | body skin under the chin | «غطّي الرقبة بالحجاب» |
| Chin covered | skin just above the chin edge | «الحجاب يغطي الذقن، اكشفي الذقن كاملًا» |
| Hands in the photo | body skin around head and shoulders, outside head and neck | «أبعدي يدك عن الصورة» |
| Uneven light | brightness gap between the two cheeks | «يوجد ظل على الجانب الأيمن/الأيسر من وجهك…» |
| No ghutra/shemagh (men) | segmentation/color above forehead | «ارتدِ الغترة أو الشماغ» |
| Red eyes | red ratio inside iris on captured frame | «أطفئ الفلاش» |
| Contact lenses, makeup | not reliably detectable → show a checklist reminder before capture | — |

Checks that can't be detected reliably must not block capture; show them as a pre-capture reminder instead. No auto-capture: the «التقاط» button is enabled only while all blocking checks pass, and the user presses it when ready.

## User flow (3 steps)
1. **Choose:** رجل / امرأة (changes the checks and wording), plus a short reminder card (glasses off, plain clothes, face the light).
2. **Capture:** live camera with a face-shaped overlay guide, one guidance message at a time (highest priority first), progress indicator, manual «التقاط» button (enabled only when all checks pass).
3. **Result:** preview on white background at 4×6, buttons: **تنزيل الصورة** (JPG) and **إعادة التصوير**.

## Output
- Composite the person onto pure white (#FFFFFF) using the segmentation mask with a soft feathered edge.
- Crop so the head fits the ratios above; export 472×709 JPG (quality ~0.92). Filename: `sura-ahwal.jpg`.

## Design
- Calm, official, elegant. Not playful. Saudi-green accent, generous whitespace, clear typography (an Arabic web font such as IBM Plex Sans Arabic or Tajawal from Google Fonts).
- Works in light and dark mode. Large touch targets.

## Files
- `index.html`, `style.css`, `app.js` (camera + loop + UI), `checks.js` (all checks, pure functions), `config.js` (requirements, thresholds and messages), `export.js` (segmentation, crop, JPG).
- `guide.html` (photo rules for women then men, with a correct sample each), `policy.html` (privacy, terms, contact), `favicon.svg` (logo, also used in the header), `assets/` (sample images).
- Append `?debug` to the URL to see the live numbers behind every check when tuning `config.js`.

## Workflow
- Build in small steps and test each on a real phone (GitHub Pages or a local HTTPS tunnel, since the camera needs HTTPS).
- Tune thresholds in `config.js`, not inside the checks.
