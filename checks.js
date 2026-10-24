// Pure checks: numbers in, a guidance key out. No DOM, no camera.

// Multiclass segmenter categories.
export const SEG = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };

// Face Mesh landmark indices. "Right"/"left" are the person's own sides; in the
// unmirrored frame the person's right is on the image left.
export const LM = {
  forehead: 10,
  chin: 152,
  noseTip: 1,
  rightEyeOuter: 33,
  leftEyeOuter: 263,
  rightCheek: 234,
  leftCheek: 454,
  rightCheekCenter: 50,
  leftCheekCenter: 280,
  brows: [66, 105, 296, 334],
  // Face outline, clockwise from the top of the forehead.
  faceOval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400,
    377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
};

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Reads the category mask around the head and returns shares in 0..1:
 *   hair, cover  hair and head cover (ghutra/hijab) above the brows
 *   forehead     visible forehead skin above the brows, per brows-to-chin span
 *   faceSkin     uncovered face below the brows, in the more covered half
 *   chin         uncovered skin just above the chin edge
 *   ears         skin beside the face at ear height (worse side)
 *   loose        background or hair right beside the face (worse side): hijab not snug
 *   neck         body skin below the chin
 *   hands        body skin elsewhere around the head and shoulders, per face area
 * cat: Uint8Array category mask, mw x mh, covering the whole (unmirrored) frame.
 * face: normalized landmarks from the same frame.
 */
export function analyzeHead(cat, mw, mh, face) {
  const px = (i) => face[i].x * mw;
  const py = (i) => face[i].y * mh;

  const left = Math.min(px(LM.rightCheek), px(LM.leftCheek));
  const right = Math.max(px(LM.rightCheek), px(LM.leftCheek));
  const fw = right - left;
  const browY = Math.min(...LM.brows.map(py));
  const chinY = py(LM.chin);
  const span = chinY - browY; // brows to chin
  if (fw < 4 || span < 4) return null;

  const noseX = px(LM.noseTip);
  const chinX = px(LM.chin);
  const eyeY = (py(LM.rightEyeOuter) + py(LM.leftEyeOuter)) / 2;
  const step = Math.max(1, Math.round(fw / 120));
  const at = (x, y) => cat[Math.round(y) * mw + Math.round(x)];
  const isSkin = (c) => c === SEG.faceSkin || c === SEG.bodySkin;

  // Counts categories over a box (clipped to the mask), optionally filtered.
  function tally(x0, y0, x1, y1, keep = () => true) {
    const n = [0, 0, 0, 0, 0, 0];
    let total = 0;
    for (let y = Math.max(0, y0); y <= Math.min(mh - 1, y1); y += step) {
      for (let x = Math.max(0, x0); x <= Math.min(mw - 1, x1); x += step) {
        if (!keep(x, y)) continue;
        n[at(x, y)]++;
        total++;
      }
    }
    return { n, total, share: (...cs) => (total ? cs.reduce((s, c) => s + n[c], 0) / total : 0) };
  }

  // Above the brows, inside the face width: hair vs. head cover.
  const top = tally(left + fw * 0.15, browY - span * 0.9, right - fw * 0.15, browY - span * 0.08);
  const person = top.total - top.n[SEG.background];
  const hair = person ? top.n[SEG.hair] / person : 0;
  const cover = person ? (top.n[SEG.clothes] + top.n[SEG.others]) / person : 0;

  // Forehead: walk up from the brows along the face center while it is skin.
  const cx = Math.min(mw - 1, Math.max(0, px(LM.forehead)));
  let skinRows = 0;
  let gap = 0;
  for (let y = Math.max(0, browY - span * 0.05); y >= 0; y--) {
    if (at(cx, y) === SEG.faceSkin) {
      skinRows += 1 + gap;
      gap = 0;
    } else if (++gap > 2) {
      break;
    }
  }

  // Face below the brows, each half separately. Only face skin or beard counts
  // as uncovered (a hand is body skin). The outline is shrunk so fabric that
  // only frames the face edge does not count.
  const midY = (browY + chinY) / 2;
  const poly = LM.faceOval.map((i) => [noseX + (px(i) - noseX) * 0.85, midY + (py(i) - midY) * 0.85]);
  const inFace = (x, y) =>
    x >= left && x <= right && y >= browY && y <= chinY && insidePolygon(x, y, poly);
  const faceL = tally(left, browY + span * 0.05, noseX, chinY, inFace);
  const faceR = tally(noseX, browY + span * 0.05, right, chinY, inFace);
  const faceSkin = Math.min(faceL.share(SEG.faceSkin, SEG.hair), faceR.share(SEG.faceSkin, SEG.hair));

  // Chin: the strip just above the chin edge.
  const chin = tally(chinX - fw * 0.15, chinY - span * 0.2, chinX + fw * 0.15, chinY - span * 0.04)
    .share(SEG.faceSkin, SEG.hair);

  // Beside the face at ear height. Skin there is an ear; background or hair
  // right next to the face means the hijab is not wrapped snugly.
  const earY0 = eyeY - span * 0.05;
  const earY1 = eyeY + span * 0.45;
  const sideR = tally(left - fw * 0.22, earY0, left - fw * 0.02, earY1);
  const sideL = tally(right + fw * 0.02, earY0, right + fw * 0.22, earY1);
  const ears = Math.max(sideR.share(SEG.faceSkin, SEG.bodySkin), sideL.share(SEG.faceSkin, SEG.bodySkin));
  // A snug hijab hugs the face edge, so check only a thin band against it.
  const hugR = tally(left - fw * 0.06, earY0, left + fw * 0.02, earY1);
  const hugL = tally(right - fw * 0.02, earY0, right + fw * 0.06, earY1);
  const loose = Math.max(hugR.share(SEG.background, SEG.hair), hugL.share(SEG.background, SEG.hair));

  // Neck: body skin in the band under the chin.
  const neck = tally(chinX - fw * 0.4, chinY + span * 0.04, chinX + fw * 0.4, chinY + span * 0.6)
    .share(SEG.bodySkin);

  // Hands: body skin around the head and shoulders, outside the head itself and
  // outside the column under the chin (neck and an open collar are not hands).
  // A hand over the face shows up in faceSkin instead (it is body skin, not face skin).
  const inNeck = (x, y) => y > chinY && Math.abs(x - chinX) < fw * 0.5;
  const inHead = (x, y) =>
    x > left - fw * 0.12 && x < right + fw * 0.12 && y > browY - span * 0.9 && y < chinY + span * 0.1;
  const around = tally(left - fw * 0.8, browY - span * 0.9, right + fw * 0.8, chinY + span * 1.2,
    (x, y) => !inNeck(x, y) && !inHead(x, y));
  const faceArea = Math.max(1, faceL.total + faceR.total);
  const hands = around.n[SEG.bodySkin] / faceArea;

  return {
    hair,
    cover,
    forehead: skinRows / span,
    faceSkin,
    chin,
    ears,
    loose,
    neck,
    hands,
  };
}

/**
 * Head yaw and pitch in degrees from a 4x4 column-major face transformation matrix.
 */
export function headPose(matrix) {
  const m = matrix;
  const r20 = m[2], r21 = m[6], r22 = m[10];
  const toDeg = 180 / Math.PI;
  return {
    yawDeg: Math.atan2(-r20, Math.hypot(r21, r22)) * toDeg,
    pitchDeg: Math.atan2(r21, r22) * toDeg,
  };
}

/**
 * Gaze direction from eyeLook* blendshapes, averaged over both eyes (0..1).
 */
export function gazeFrom(categories) {
  const s = {};
  for (const c of categories) s[c.categoryName] = c.score;
  const lookLeft = ((s.eyeLookOutLeft ?? 0) + (s.eyeLookInRight ?? 0)) / 2;
  const lookRight = ((s.eyeLookInLeft ?? 0) + (s.eyeLookOutRight ?? 0)) / 2;
  return {
    gazeSide: Math.max(lookLeft, lookRight),
    gazeUp: ((s.eyeLookUpLeft ?? 0) + (s.eyeLookUpRight ?? 0)) / 2,
    gazeDown: ((s.eyeLookDownLeft ?? 0) + (s.eyeLookDownRight ?? 0)) / 2,
  };
}

/**
 * Picks the single most important guidance key.
 * m: smoothed face measurements: faceH, cx, cy (stage pixels), rollDeg, yawDeg, pitchDeg,
 *    gazeSide, gazeUp, gazeDown, luma, clipped, sideLight (-1..1, negative: the
 *    person's right cheek is darker).
 * oval: the guide oval in the same pixels.
 * head: smoothed analyzeHead() result, or null while the segmenter warms up.
 * gender: "m" or "f".
 */
export function evaluate(m, oval, head, gender, cfg) {
  const ratio = m.faceH / (oval.ry * 2);
  if (ratio < cfg.distance.min) return "tooFar";
  if (ratio > cfg.distance.max) return "tooClose";

  const dx = (m.cx - oval.cx) / (oval.rx * 2);
  const dy = (m.cy - (oval.cy + oval.ry * cfg.center.targetOffsetY)) / (oval.ry * 2);
  // Selfie view: moving the phone left shifts the face right on screen.
  if (dx < -cfg.center.maxX) return "moveLeft";
  if (dx > cfg.center.maxX) return "moveRight";
  // Raising the phone shifts the face down on screen.
  if (dy < -cfg.center.maxY) return "moveUp";
  if (dy > cfg.center.maxY) return "moveDown";

  if (Math.abs(m.rollDeg) > cfg.tiltMaxDeg) return "tilt";
  if (Math.abs(m.yawDeg) > cfg.pose.maxYawDeg || Math.abs(m.pitchDeg) > cfg.pose.maxPitchDeg) {
    return "faceForward";
  }
  const g = cfg.gaze;
  if (m.gazeSide > g.maxSide || m.gazeUp > g.maxUp || m.gazeDown > g.maxDown) return "lookAhead";

  if (head) {
    const c = cfg.cover;
    if (head.hands > c.maxHands) return "handsVisible";
    if (head.faceSkin < c.minFaceSkin) return "faceCovered";
    if (head.chin < c.minChin) return "chinCovered";
    if (gender === "m") {
      if (head.cover < c.minCoverMen) return "noGhutra";
    } else {
      if (head.hair > c.maxHairWomen) return "hairShowing";
      if (head.forehead < c.minForehead) return "foreheadCovered";
      if (head.ears > c.maxEarsWomen) return "earsShowing";
      if (head.loose > c.maxLooseWomen) return "hijabLoose";
      if (head.neck > c.maxNeckWomen) return "neckShowing";
    }
  }

  const L = cfg.light;
  if (m.luma < L.minMean) return "tooDark";
  if (m.luma > L.maxMean || m.clipped > L.maxClippedRatio) return "tooBright";
  if (m.sideLight < -L.maxSideDiff) return "shadowRight";
  if (m.sideLight > L.maxSideDiff) return "shadowLeft";

  return "ok";
}
