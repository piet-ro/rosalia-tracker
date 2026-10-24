// Peel stack: a pile of cover cards that peel off and fly out like confetti when tapped.
//
// Each card is a thin 3D box made of hinged strips, so soft cards can bend. Cards in the
// air are rigid bodies: they collide as oriented boxes (separating-axis test) and exchange
// momentum and spin, so they bump instead of passing through each other.
//
//   const stack = createPeelStack({ stage, anchor, covers, params });
//   stack.fire();
//
// stage   element that becomes a full-screen 3D layer (created by the caller, empty)
// anchor  function returning the screen point { x, y } where the pile sits
// covers  front images (URLs), oldest first; the last one is on top

export const DEFAULTS = {
  size: 125, thick: 2, radius: 12, stackGap: 0, jitter: 7.5,
  hardness: 0.26, reflection: 0.4, shininess: 19, squash: 8,
  backBlur: 8,
  peel: 0.2, peelTilt: 38,
  power: 1400, spread: 75, zKick: 400,
  gravity: 650, drag: 0.006, flutter: 320, flutterHz: 1.2, sway: 38,
  spin: 500, spinDrag: 1.8, settleSpin: 90,
  bounce: 0.3, friction: 0.3,
  burstLength: 2.6, burstEase: 1.5, endPower: 0.4,
  startPause: 0.7, refillPause: 2,
  dropHeight: 330, dropFall: 0.33, dropGap: 0.14, dropMax: 4, dropTurn: 15, dropSettle: 0.77,
  dropShadow: 0.72, dropBlur: 0, dropTilt: 11, dropDrift: 33, dropImpact: 1.25,
  nudge: 0.5, nudgeLift: 40, nudgeTurn: 10, nudgeTime: 1.3, nudgeEvery: 7
};

const STRUCTURAL = ['size', 'thick', 'radius', 'jitter', 'backBlur'];
const FOCUS_BLUR = 6;  // how soft a cover looks while it is high above the pile, before it comes into focus
const DEG = Math.PI / 180;
const SEG = 6, HALF = SEG / 2;
const MAX_BEND = 28;
const STEP = 1 / 240;
// Rebuilding the pile: covers drop onto it from in front of the screen, as if from straight above with the
// camera overhead. One leaves every dropGap seconds (a long pile speeds up so the drop stays under dropMax),
// falls for dropFall, lands on the cover below, then turns into its resting angle over dropSettle.
const popGap = (P, n) => Math.min(P.dropGap, P.dropMax / Math.max(1, n));
const LIGHT = (() => { const l = [-0.35, -0.6, 0.72]; const m = Math.hypot(...l); return l.map(v => v / m); })();

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- small vector / rotation helpers ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const col = (R, i) => [R[0][i], R[1][i], R[2][i]];
const mulMV = (R, v) => [dot(R[0], v), dot(R[1], v), dot(R[2], v)];
const mulMM = (A, B) => A.map(row => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
// rotation by angle (radians) around a unit axis (Rodrigues)
function axisMatrix([x, y, z], a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c]
  ];
}
const mulMtV = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]];

// CSS rotateX(a) rotateY(b) rotateZ(c), y pointing down
function eulerMatrix(rx, ry, rz) {
  const a = rx * DEG, b = ry * DEG, g = rz * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  return [
    [cb * cg, -cb * sg, sb],
    [ca * sg + sa * sb * cg, ca * cg - sa * sb * sg, -sa * cb],
    [sa * sg - ca * sb * cg, sa * cg + ca * sb * sg, ca * cb]
  ];
}
function quatMatrix([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
  ];
}
function matrixQuat(R) {
  const tr = R[0][0] + R[1][1] + R[2][2];
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [s / 4, (R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s];
  } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const s = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    q = [(R[2][1] - R[1][2]) / s, s / 4, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s];
  } else if (R[1][1] > R[2][2]) {
    const s = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    q = [(R[0][2] - R[2][0]) / s, (R[0][1] + R[1][0]) / s, s / 4, (R[1][2] + R[2][1]) / s];
  } else {
    const s = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
    q = [(R[1][0] - R[0][1]) / s, (R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, s / 4];
  }
  return q;
}
function integrateQuat(q, w, dt) {
  const [qw, qx, qy, qz] = q, [wx, wy, wz] = w, h = dt / 2;
  const n = [
    qw + h * (-wx * qx - wy * qy - wz * qz),
    qx + h * (wx * qw + wy * qz - wz * qy),
    qy + h * (wy * qw + wz * qx - wx * qz),
    qz + h * (wz * qw + wx * qy - wy * qx)
  ];
  const m = Math.hypot(...n);
  return n.map(v => v / m);
}

function spring(pos, vel, target, k, damp, dt) {
  vel += (-k * (pos - target) - damp * vel) * dt;
  return [pos + vel * dt, vel];
}

// ---------- collision: oriented boxes ----------
// Returns { n (A to B), depth } or null.
function satBoxes(A, B) {
  // 15 candidate axes: 3 face normals of each box and the 9 edge-edge cross products. Written without
  // temporary arrays because it runs for every close pair, 240 times a second.
  const RA = A.R, RB = B.R, hA = A.h, hB = B.h;
  const t0 = B.p[0] - A.p[0], t1 = B.p[1] - A.p[1], t2 = B.p[2] - A.p[2];
  let bestRank = Infinity, depth = 0, n0 = 0, n1 = 0, n2 = 0;
  for (let k = 0; k < 15; k++) {
    let l0, l1, l2;
    if (k < 3) { l0 = RA[0][k]; l1 = RA[1][k]; l2 = RA[2][k]; }
    else if (k < 6) { l0 = RB[0][k - 3]; l1 = RB[1][k - 3]; l2 = RB[2][k - 3]; }
    else {
      const i = ((k - 6) / 3) | 0, j = (k - 6) % 3;
      const a0 = RA[0][i], a1 = RA[1][i], a2 = RA[2][i], b0 = RB[0][j], b1 = RB[1][j], b2 = RB[2][j];
      l0 = a1 * b2 - a2 * b1; l1 = a2 * b0 - a0 * b2; l2 = a0 * b1 - a1 * b0;
      const m = Math.sqrt(l0 * l0 + l1 * l1 + l2 * l2);
      if (m < 1e-3) continue;
      l0 /= m; l1 /= m; l2 /= m;
    }
    const rA = hA[0] * Math.abs(RA[0][0] * l0 + RA[1][0] * l1 + RA[2][0] * l2) +
      hA[1] * Math.abs(RA[0][1] * l0 + RA[1][1] * l1 + RA[2][1] * l2) +
      hA[2] * Math.abs(RA[0][2] * l0 + RA[1][2] * l1 + RA[2][2] * l2);
    const rB = hB[0] * Math.abs(RB[0][0] * l0 + RB[1][0] * l1 + RB[2][0] * l2) +
      hB[1] * Math.abs(RB[0][1] * l0 + RB[1][1] * l1 + RB[2][1] * l2) +
      hB[2] * Math.abs(RB[0][2] * l0 + RB[1][2] * l1 + RB[2][2] * l2);
    const d = t0 * l0 + t1 * l1 + t2 * l2;
    const overlap = rA + rB - Math.abs(d);
    if (overlap <= 0) return null;
    const rank = k < 6 ? overlap : overlap * 1.05 + 0.1;  // prefer face contacts for stability
    if (rank < bestRank) {
      const sgn = d < 0 ? -1 : 1;
      bestRank = rank; depth = overlap; n0 = l0 * sgn; n1 = l1 * sgn; n2 = l2 * sgn;
    }
  }
  return { depth, n: [n0, n1, n2] };
}

function pileContact(A, pile) {
  const reachZ = A.h[0] * Math.abs(A.R[2][0]) + A.h[1] * Math.abs(A.R[2][1]) + A.h[2] * Math.abs(A.R[2][2]);
  const front = A.p[2] >= pile.p[2];
  const depth = front ? (pile.p[2] + pile.h[2]) - (A.p[2] - reachZ) : (A.p[2] + reachZ) - (pile.p[2] - pile.h[2]);
  if (depth <= 0) return null;
  const n = [0, 0, front ? -1 : 1];  // points from the cover into the pile
  return { depth, n, c: supportPoint(A, n) };
}

function supportPoint(body, dir) {
  const verts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    verts.push(add(add(add(body.p, col(body.R, 0), sx * body.h[0]), col(body.R, 1), sy * body.h[1]), col(body.R, 2), sz * body.h[2]));
  }
  const proj = verts.map(v => dot(v, dir));
  const max = Math.max(...proj), eps = 0.02 * body.h[0];
  const pick = verts.filter((v, i) => proj[i] > max - eps);
  return scale(pick.reduce((s, v) => add(s, v), [0, 0, 0]), 1 / pick.length);
}

const invInertiaWorld = (b, v) => b.invMass === 0 ? [0, 0, 0] : mulMV(b.R, mulMtV(b.R, v).map((x, i) => x * b.invI[i]));

function applyImpulse(b, J, r) {
  if (b.invMass === 0) return;
  b.v = add(b.v, J, b.invMass);
  b.w = add(b.w, invInertiaWorld(b, cross(r, J)));
}

function resolve(A, B, hit, P, onHit) {
  const n = hit.n;
  const c = hit.c || scale(add(supportPoint(A, n), supportPoint(B, scale(n, -1))), 0.5);
  const rA = sub(c, A.p), rB = sub(c, B.p);
  const totalInv = A.invMass + B.invMass;
  // ease overlapping boxes apart instead of teleporting them
  // against something immovable (the pile, a peeling cover) the moving one has to give way faster
  const solid = A.invMass === 0 || B.invMass === 0;
  const corr = Math.min(Math.max(hit.depth - 0.3, 0) * (solid ? 0.6 : 0.35), solid ? 6 : 2.5) / totalInv;
  A.p = add(A.p, n, -corr * A.invMass);
  B.p = add(B.p, n, corr * B.invMass);

  const vel = (b, r) => add(b.v, cross(b.w, r));
  const vrel = sub(vel(B, rB), vel(A, rA));
  const vn = dot(vrel, n);
  if (vn >= 0) return;
  const k = (dir) => totalInv +
    dot(dir, cross(invInertiaWorld(A, cross(rA, dir)), rA)) +
    dot(dir, cross(invInertiaWorld(B, cross(rB, dir)), rB));
  const j = -(1 + P.bounce) * vn / k(n);
  applyImpulse(A, scale(n, -j), rA);
  applyImpulse(B, scale(n, j), rB);

  const vt = sub(vrel, scale(n, vn)), vtl = Math.hypot(...vt);
  if (vtl > 1e-3) {
    const t = scale(vt, 1 / vtl);
    const jt = clamp(-vtl / k(t), -P.friction * j, P.friction * j);
    applyImpulse(A, scale(t, -jt), rA);
    applyImpulse(B, scale(t, jt), rB);
  }
  onHit(A, B, j);
}

// ---------- images ----------
// The back of a cover shows the front seen through it: the same picture, mirrored by the turn
// and softened. The blur is baked once per image by shrinking and re-enlarging it on a canvas.
// If the image does not allow that (no CORS), the back falls back to a CSS blur.
const blurCache = new Map();
function blurredCopy(url, amount) {
  const key = url + '|' + amount;
  if (!blurCache.has(key)) {
    blurCache.set(key, new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const out = 96, small = Math.max(2, Math.round(out / (1 + amount / 2)));
          const a = document.createElement('canvas'); a.width = a.height = small;
          const ga = a.getContext('2d'); ga.imageSmoothingQuality = 'high';
          ga.drawImage(img, 0, 0, small, small);
          const b = document.createElement('canvas'); b.width = b.height = out;
          const gb = b.getContext('2d'); gb.imageSmoothingQuality = 'high';
          gb.drawImage(a, 0, 0, out, out);
          resolve(b.toDataURL('image/jpeg', 0.85));
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      // a separate URL so the browser cannot reuse a copy it fetched without CORS for the plain <img>
      img.src = url.startsWith('data:') ? url : url + (url.includes('?') ? '&' : '?') + 'blur';
    }));
  }
  return blurCache.get(key);
}

// ---------- the stack ----------
export function createPeelStack({ stage, anchor, covers = [], params = {}, back = null, autoRestack = false, autoplay = false, onTopTap = null }) {
  let P = { ...DEFAULTS, ...params };
  let images = covers.slice();
  let cards = [], flying = [];
  let timeScale = 1, onePerTap = false, seq = null, charge = 0, charging = false, pileShift = 0, restackIn = -1, playIn = -1, autoplayNext = autoplay, nextNudge = 3, alive = true, acc = 0;
  let stackBody = null;
  let maxDepth = 0;  // deepest overlap seen since the last restack, for debugging

  Object.assign(stage.style, {
    position: 'fixed', inset: '0', perspective: '1000px', overflow: 'hidden',
    pointerEvents: 'none', zIndex: stage.style.zIndex || '50'
  });
  const world = document.createElement('div');
  Object.assign(world.style, { position: 'absolute', left: '0', top: '0', transformStyle: 'preserve-3d' });
  stage.appendChild(world);
  const style = document.createElement('style');
  style.textContent = `
    .ps-card, .ps-seg { position: absolute; transform-style: preserve-3d; }
    .ps-card { will-change: transform; }
    .ps-card.ps-top { pointer-events: auto; cursor: pointer; }
    .ps-card.ps-top:focus-visible { outline: none; }
    .ps-card.ps-fly { pointer-events: auto; touch-action: none; }
    .ps-mirror { position: absolute; inset: 0; transform: scaleX(-1); background-repeat: no-repeat; }
    .ps-shadow { position: absolute; inset: 2px; pointer-events: none; transition: opacity 0.25s ease; }
    .ps-shadow { opacity: 0; }
    .ps-card.ps-top .ps-shadow { opacity: 1; }
    .ps-seg { left: 0; }
    .ps-face { position: absolute; inset: 0; backface-visibility: hidden; overflow: hidden; background-repeat: no-repeat; }
    .ps-shade, .ps-spec { position: absolute; inset: 0; pointer-events: none; }
    .ps-spec { background-image: linear-gradient(115deg, transparent 42%, rgba(255,255,255,0.95) 50%, transparent 58%); background-repeat: no-repeat; opacity: 0; }
    .ps-edge { position: absolute; backface-visibility: hidden; }`;
  stage.appendChild(style);

  // ----- building -----
  // A card is a column of SEG hinged strips chained outward from the middle, so bending the joints curls the sheet.
  function buildCard(i) {
    const w = Math.round(P.size), t = P.thick, mid = Math.floor(w / 2);
    const split = (total) => { const b = Math.floor(total / HALF); return Array.from({ length: HALF }, (_, k) => b + (k < total - b * HALF ? 1 : 0)).reverse(); };
    const heights = { up: split(mid), down: split(w - mid) };
    const r = Math.min(P.radius, Math.min(heights.up[HALF - 1], heights.down[HALF - 1]) * 0.95);
    const root = document.createElement('div');
    root.className = 'ps-card';
    root.style.cssText = `width:${w}px;height:${w}px;left:${-mid}px;top:${-mid}px`;
    const front = images[i];
    const c = {
      el: root, i, segs: [], backs: [], edges: [], focus: [],
      x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: rand(-P.jitter, P.jitter),
      sy: 0, svy: 0, sz: 0, svz: 0, s: 1, sv: 0, srx: 0, svrx: 0,
      bt: 0, btv: 0, bb: 0, bbv: 0,  // bend per joint (deg) of the top and bottom halves
      state: 'stack', pop: null
    };
    c.R = eulerMatrix(0, 0, c.rz);
    const mk = (parent, cls, css) => { const d = document.createElement('div'); d.className = cls; d.style.cssText = css; parent.appendChild(d); return d; };
    for (const up of [true, false]) {
      let parent = root, at = mid;
      for (let k = 0; k < HALF; k++) {
        const hS = (up ? heights.up : heights.down)[k];
        const segTop = up ? at - hS : at;
        at = up ? at - hS : at + hS;
        const outer = k === HALF - 1;
        const pos = k === 0 ? `top:${segTop}px` : (up ? 'bottom:100%' : 'top:100%');
        const seg = mk(parent, 'ps-seg', `width:${w}px;height:${hS}px;${pos};transform-origin:50% ${up ? '100%' : '0%'}`);
        const rad = outer ? (up ? `${r}px ${r}px 0 0` : `0 0 ${r}px ${r}px`) : '0';
        // Faces sit off the hinge by half the thickness, so a bend opens a thin gap on its outside.
        // Each face reaches 1.5px past every inner joint to cover it; the card's outer edge gets no overlap.
        const topIn = !(up && outer), botIn = !(!up && outer);
        const extT = topIn ? 1.5 : 0, extB = botIn ? 1.5 : 0;
        // a 1px transparent margin on the outer sides lets the GPU smooth the card's silhouette when it is tilted
        const padTop = topIn ? 0 : 1, padBot = botIn ? 0 : 1;
        const bg = `padding:${padTop}px 1px ${padBot}px;background-clip:content-box;background-size:${w}px ${w}px;background-position:0 ${extT - segTop}px;background-repeat:no-repeat`;
        const box = `top:${-extT}px;bottom:${-extB}px;border-radius:${rad}`;
        const ov = `left:1px;right:1px;top:${padTop}px;bottom:${padBot}px`;
        const f = mk(seg, 'ps-face', `${box};${bg};background-image:url("${front}");transform:translateZ(${t / 2}px)`);
        const fShade = mk(f, 'ps-shade', ov);
        const fSpec = mk(f, 'ps-spec', `${ov};background-size:${2 * w}px ${2 * w}px`);
        // an out-of-focus copy of the picture, faded in while the cover is falling from high up
        c.focus.push(mk(f, 'ps-shade', `${ov};opacity:0;background-repeat:no-repeat;background-size:${w}px ${w}px;background-position:-1px ${extT - segTop - padTop}px`));
        // the back is the front seen from behind: mirrored left to right, like looking through the cover
        const b = mk(seg, 'ps-face', `${box};transform:rotateY(180deg) translateZ(${t / 2}px)`);
        c.backs.push(mk(b, 'ps-mirror', `${bg};background-image:url("${back || front}")`));
        const bShade = mk(b, 'ps-shade', ov);
        if (t > 0) {
          // Edges show the colours of the picture next to them, so the thickness never reads as a white or black band.
          // They sit 1px in, against the visible picture, and also reach over the inner joints.
          const eTop = (outer && up ? r : 0) - (topIn ? 1 : 0);
          const eH = hS - (outer ? r : 0) + (topIn ? 1 : 0) + (botIn ? 1 : 0);
          // a fixed tint (no filter) keeps the sides a touch darker than the faces, so they read as sides
          const edgeFace = (px, py, css) => c.edges.push(mk(seg, 'ps-edge', `--img:url("${front}");background-image:linear-gradient(rgba(0,0,0,.18),rgba(0,0,0,.18)),var(--img);background-size:100% 100%,${w}px ${w}px;background-position:0 0,${px}px ${py}px;background-repeat:no-repeat;${css}`));
          edgeFace(-1, -segTop - eTop, `width:${t}px;height:${eH}px;left:${1 - t / 2}px;top:${eTop}px;transform:rotateY(-90deg)`);
          edgeFace(-(w - 1 - t), -segTop - eTop, `width:${t}px;height:${eH}px;left:${w - 1 - t / 2}px;top:${eTop}px;transform:rotateY(90deg)`);
          if (outer) {
            edgeFace(-r, up ? -1 : -(w - 1 - t), `width:${w - 2 * r}px;height:${t}px;left:${r}px;top:${up ? 1 - t / 2 : hS - 1 - t / 2}px;transform:rotateX(${up ? 90 : -90}deg)`);
            // one angled piece across each rounded corner, so the thickness has no notch there
            if (r > 1) {
              const chord = r * Math.SQRT2, m = r / 2 + 0.3;  // midpoint of the corner arc's chord, nudged onto the picture
              for (const right of [false, true]) {
                const cx = right ? w - m : m, cy = up ? m : hS - m;
                const turn = (up ? 1 : -1) * (right ? 45 : -45);
                edgeFace(-(cx - t / 2), -(segTop + cy - t / 2), `width:${chord}px;height:${t}px;left:${cx - chord / 2}px;top:${cy - t / 2}px;transform:rotateZ(${turn}deg) rotateX(${up ? 90 : -90}deg)`);
              }
            }
          }
        }
        c.segs.push({ el: seg, up, k, segTop, fShade, fSpec, bShade });
        parent = seg;
      }
    }
    blurredCopy(front, FOCUS_BLUR).then(url => { if (url) c.focus.forEach(f => { f.style.backgroundImage = `url("${url}")`; }); });
    if (!back && P.backBlur > 0) {
      c.backs.forEach(f => { f.style.filter = `blur(${P.backBlur * 0.4}px)`; });
      blurredCopy(front, P.backBlur).then(url => {
        if (!url) return;  // keep the CSS blur
        c.backs.forEach(f => { f.style.backgroundImage = `url("${url}")`; f.style.filter = ''; });
        c.edges.forEach(f => { f.style.setProperty('--img', `url("${url}")`); });
      });
    }
    root.addEventListener('pointerdown', e => {
      if (c.state === 'fly') { e.preventDefault(); bump(c, e); return; }
      if (c.state !== 'stack' || c !== cards[cards.length - 1]) return;
      e.preventDefault(); tap();
    });
    root.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && c === cards[cards.length - 1]) { e.preventDefault(); tap(); }
    });
    // A soft shadow under the top cover of the pile only, so shadows don't stack up and darken the pile.
    // It is a plain painted box-shadow, drawn once, just behind the cover; it fades in as a cover becomes
    // the top one and fades out (instead of jumping) as soon as it leaves the pile.
    const shadow = document.createElement('div');
    shadow.className = 'ps-shadow';
    shadow.style.cssText = `border-radius:${r}px;box-shadow:0 3px 7px rgba(0,0,0,0.32);transform:translateZ(${-t / 2 - 0.25}px)`;
    root.insertBefore(shadow, root.firstChild);
    world.appendChild(root);
    return c;
  }

  const stackY = d => d * P.stackGap;
  // While a burst runs, the top few covers of the pile spread out in depth like a spring loading,
  // so each cover leaves with clear space behind it. pileShift keeps the pile back as covers leave, then it slides forward.
  const SPREAD = 4;
  const chargedGap = () => 2 * boxHalf()[2] + 1;
  const topGap = () => P.thick + 0.5 + charge * (chargedGap() - P.thick - 0.5);
  const stackZ = d => -(Math.min(d, SPREAD) * topGap() + Math.max(0, d - SPREAD) * (P.thick + 0.5)) - pileShift;

  function markTop() {
    for (const c of flying) {
      c.el.classList.remove('ps-top');
      c.el.classList.toggle('ps-fly', c.state === 'fly');
      c.el.classList.add('ps-off');
      c.el.removeAttribute('tabindex'); c.el.removeAttribute('role'); c.el.removeAttribute('aria-label');
    }
    cards.forEach((c, k) => {
      const top = k === cards.length - 1;
      c.el.classList.toggle('ps-top', top);
      if (top) { c.el.tabIndex = 0; c.el.setAttribute('role', 'button'); c.el.setAttribute('aria-label', 'Throw the streak covers'); }
      else { c.el.removeAttribute('tabindex'); c.el.removeAttribute('role'); c.el.removeAttribute('aria-label'); }
    });
    updateStackBody();
  }

  // the resting pile is one immovable box, so falling covers bump off it instead of passing through
  function updateStackBody(dt = 0) {
    const prev = stackBody;
    if (!cards.length) { stackBody = null; return; }
    // measured from where the covers are now, not where they are heading
    const n = cards.length, w = P.size;
    const zs = cards.map(c => c.sz);
    const zTop = Math.max(...zs) + P.thick / 2, zBot = Math.min(...zs) - P.thick / 2;
    stackBody = {
      p: [0, stackY(n - 1) / 2, (zTop + zBot) / 2], v: [0, 0, 0], w: [0, 0, 0],
      R: eulerMatrix(0, 0, 0), h: [w / 2, w / 2 + stackY(n - 1) / 2, (zTop - zBot) / 2],
      invMass: 0, invI: [0, 0, 0], card: null
    };
    stackBody.rad = Math.hypot(...stackBody.h);
    // the pile moves as it settles; collisions need that motion to knock covers out of its way
    stackBody.front = zTop;
    if (prev && dt > 0) stackBody.v = [0, 0, (zTop - prev.front) / dt];
  }

  // keepFlying rebuilds the pile while covers already in the air keep falling
  function restack(keepFlying = false) {
    seq = null; charging = false; charge = 0; pileShift = 0; restackIn = -1;
    cards.forEach(c => { if (c.dropShadowEl) c.dropShadowEl.remove(); });
    if (keepFlying) cards.forEach(c => c.el.remove());
    else { world.innerHTML = ''; flying = []; maxDepth = 0; }
    cards = images.map((_, i) => buildCard(i));
    const n = cards.length;
    cards.forEach((c, k) => {  // pop-in cascade from the bottom up
      const depth = n - 1 - k;
      // hidden until its turn, then it starts close to the viewer, with a slight extra turn to settle out of
      c.dropFrom = P.dropHeight;
      c.restRz = c.rz; c.landRz = c.rz + rand(0.6, 1) * P.dropTurn * (Math.random() < 0.5 ? -1 : 1);
      const da = rand(0, Math.PI * 2);
      c.dropDrift = [Math.cos(da) * P.dropDrift, Math.sin(da) * P.dropDrift];
      c.dropPhase = rand(0, Math.PI * 2); c.landed = false;
      c.sy = c.y = stackY(depth); c.sz = c.z = stackZ(depth) + P.dropHeight; c.x = 0; c.rz = c.landRz;
      c.el.style.visibility = 'hidden';
      c.R = eulerMatrix(0, 0, c.rz);
      c.s = 1; c.sv = 0; c.delay = k * popGap(P, n); c.pop = 0;
    });
    markTop();
    nextNudge = 2.5;
    playIn = -1;  // a rebuild cancels an autoplay that has not started yet
    // on first load the pile lands, rests a moment, then plays by itself
    if (autoplayNext && cards.length) { playIn = cards.length * popGap(P, cards.length) + P.dropFall + P.dropSettle + P.startPause; autoplayNext = false; }
  }

  function makeDropShadow() {
    const el = document.createElement('div');
    const r = Math.min(P.radius, P.size / 12);
    el.style.cssText = `position:absolute;left:${-P.size / 2}px;top:${-P.size / 2}px;width:${P.size}px;height:${P.size}px;border-radius:${r}px;background:rgba(0,0,0,.35);box-shadow:0 0 22px 10px rgba(0,0,0,.35);opacity:0;pointer-events:none;will-change:transform,opacity`;
    world.appendChild(el);
    return el;
  }

  // ----- interaction -----
  // While the pile is emptying, and while any cover that was tapped is still on screen, the stage
  // catches every tap so playing with the covers cannot press the page's buttons underneath.
  // Covers in the air stay tappable.
  const shielded = () => !!seq || flying.some(c => c.bumped);

  function tap() {
    if (onTopTap) onTopTap();
    if (seq) return;
    if (!cards.length) { restack(); return; }
    if (onePerTap) { if (launchClear()) launchTop(); return; }
    // the top cover peels as the wind-up, then the rest follow in one run that starts as a bang and slows to a trickle.
    // Every cover leaves, so nothing older sits under the newest cover when the pile builds back up.
    const rest = cards.length - 1;
    launchTop();
    const times = Array.from({ length: rest }, (_, i) => P.burstLength * Math.pow(rest > 1 ? i / (rest - 1) : 0, P.burstEase));
    seq = { t: -P.peel, times, next: 0 };
    charging = rest > 0;
    if (autoRestack) restackIn = P.refillPause;  // counts down once the last cover has left the pile
  }

  function stepSequence(dt) {
    if (!seq) return;
    seq.t += dt;
    const last = Math.max(1, seq.times.length - 1);
    while (seq.next < seq.times.length && seq.t >= seq.times[seq.next]) { releaseNext(seq.next / last); seq.next++; }
    if (seq.next >= seq.times.length) { seq = null; charging = false; }
  }

  // Covers after the first leave straight from the pile without peeling, softer the later they go.
  function releaseNext(progress) {
    const c = cards.pop();
    if (!c) return;
    const ang = (-90 + rand(-P.spread / 2, P.spread / 2)) * DEG;
    Object.assign(c, {
      state: 'fly', t: 0, dirX: Math.cos(ang), dirY: Math.sin(ang),
      v0: P.power * (1 + (P.endPower - 1) * progress) * rand(0.9, 1.2),
      phase: rand(0, Math.PI * 2), hz: P.flutterHz * rand(0.75, 1.3)
    });
    c.x = 0; c.y = c.sy; c.z = c.sz;
    holdBody(c);
    releaseBody(c, Math.max(150, P.zKick * (1.3 - 0.8 * progress) * rand(0.8, 1.1)));
    c.sv += P.squash;
    flying.push(c);
    pileShift += topGap();
    markTop();
    const top = cards[cards.length - 1];
    if (top) { top.sv -= P.squash * 0.4; top.svz -= 60; }
  }

  // The next cover can only peel once the space it lifts into is empty.
  function launchClear() {
    const [hx, , hz] = boxHalf(), lift = P.size * 0.35;
    const space = { p: [0, 0, lift / 2 + hz], R: eulerMatrix(0, 0, 0), h: [hx, hx, lift / 2 + hz] };
    return flying.every(f => f.state === 'fly' && !satBoxes(f.body, space));
  }

  // A cover finishes peeling before the next one starts, so two peeling covers never pass through each other.
  function launchTop(maxPeel = Infinity, powerScale = 1) {
    if (cards.length) cards[cards.length - 1].lift = null;
    for (const f of flying) if (f.state === 'peel') f.peelDur = Math.min(f.peelDur, f.t);
    const c = cards.pop();
    if (!c) return;
    const ang = (-90 + rand(-P.spread / 2, P.spread / 2)) * DEG;
    Object.assign(c, {
      state: 'peel', t: 0, peelDur: Math.max(0.02, Math.min(P.peel, maxPeel)),
      dirX: Math.cos(ang), dirY: Math.sin(ang), v0: P.power * powerScale * rand(0.8, 1.2),
      baseY: c.sy, baseZ: c.sz, baseRx: c.srx, baseBt: c.bt,
      phase: rand(0, Math.PI * 2), hz: P.flutterHz * rand(0.75, 1.3)
    });
    holdBody(c);
    flying.push(c);
    markTop();
    const top = cards[cards.length - 1];  // the newly exposed cover wobbles like jelly
    if (top) { top.sv -= P.squash * (cards.length === 1 ? 0.9 : 0.6); top.svz += cards.length === 1 ? 220 : 120; }
  }

  // collision box: slightly larger than the drawn card, and thicker for bendy cards so curled edges stay clear
  function boxHalf() {
    const t = Math.max(P.thick, 6) + (1 - P.hardness) * 8;
    return [P.size * 0.515, P.size * 0.515, t / 2];
  }

  // while it peels, the card follows its scripted lift as a solid that cannot be pushed,
  // so covers still in the way get shoved aside instead of overlapping it
  function holdBody(c) {
    const h = boxHalf();
    c.body = { p: [c.x, c.y, c.z], v: [0, 0, 0], w: [0, 0, 0], R: c.R, h, rad: Math.hypot(...h), invMass: 0, invI: [0, 0, 0], card: c };
  }

  function releaseBody(c, vz = P.zKick * rand(0.15, 1)) {
    c.el.classList.add('ps-fly');  // falling covers can be tapped
    const b = c.body, m = 1, [hx, , hz] = b.h;
    Object.assign(b, {
      v: [c.dirX * c.v0, c.dirY * c.v0, vz],  // off the pile, so always toward you
      q: matrixQuat(c.R),
      w: [rand(-1, 1) * P.spin * DEG, rand(-1, 1) * P.spin * DEG, rand(-0.5, 0.5) * P.spin * DEG],
      invMass: 1 / m,
      invI: [12 / (m * (4 * hx * hx + 4 * hz * hz)), 12 / (m * (4 * hx * hx + 4 * hz * hz)), 12 / (m * 8 * hx * hx)],
      drift: [rand(-1, 1), rand(-1, 1), rand(-1, 1)].map(v => v * P.settleSpin * DEG),
      swayW: [0, 0, 0]
    });
    b.R = quatMatrix(b.q);
  }

  // A tap on a falling cover knocks it up and away from the finger, spinning around the spot that was hit.
  function bump(c, e) {
    const b = c.body;
    if (!b || b.invMass === 0) return;
    const { x: ax, y: ay } = anchor();
    const sc = 1000 / Math.max(200, 1000 - c.z);  // stage perspective is 1000px
    const lx = (e.clientX - ax) / sc - c.x, ly = (e.clientY - ay) / sc - c.y;
    // cancel the fall first, so even a fast cover pops back up a little
    // never pushed further away (which would shrink it): a cover moving away from you just stops receding
    const J = [-lx * 2 + rand(-60, 60), -(Math.max(0, b.v[1]) + rand(250, 380)), Math.max(0, -b.v[2])];
    applyImpulse(b, J, [lx, ly, 0]);
    c.sv -= P.squash * 0.6;
    c.btv += (1 - P.hardness) * rand(-250, 250);
    c.bumped = true;
  }

  // The attention nudge is a feedforward: the top cover stays flat, facing you, rises a little toward you
  // and swings around a pinned point halfway between its centre and one corner, showing a sliver of the
  // cover below, then eases back into place. The corner and the swing direction change at random each time.
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  let lastCorner = -1;
  function nudgeTop() {
    const c = cards[cards.length - 1];
    if (!c || c.delay > 0 || c.pop !== null || c.lift) return;
    let k;
    do { k = Math.floor(Math.random() * 4); } while (k === lastCorner);
    lastCorner = k;
    c.lift = { t: 0, dur: P.nudgeTime * rand(0.9, 1.1), corner: CORNERS[k], sign: Math.random() < 0.5 ? -1 : 1 };
  }

  // How far into the peel the nudge is (0..1): it rises smoothly, then settles back down,
  // quick at first and slowing as it lands (ease-out).
  function liftAmount(c, dt) {
    const L = c.lift;
    L.t += dt;
    const u = L.t / L.dur;
    if (u >= 1) { c.lift = null; return 0; }
    if (u < 0.45) { const v = u / 0.45; return v * v * (3 - 2 * v); }
    const v = (u - 0.45) / 0.55;
    return Math.pow(1 - v, 3);
  }

  // ----- simulation -----
  const bendK = () => 25 + 600 * P.hardness * P.hardness;
  function stepBend(c, tTop, tBot, dt) {
    if (P.hardness >= 0.999) { c.bt = c.bb = c.btv = c.bbv = 0; return; }
    const k = bendK(), d = 2 * Math.sqrt(k) * 0.3;
    [c.bt, c.btv] = spring(c.bt, c.btv, tTop, k, d, dt);
    [c.bb, c.bbv] = spring(c.bb, c.bbv, tBot, k, d, dt);
    c.bt = clamp(c.bt, -40, 40); c.bb = clamp(c.bb, -40, 40);
  }

  function stepStack(dt) {
    const n = cards.length;
    cards.forEach((c, k) => {
      if (c.delay > 0) { c.delay -= dt; return; }
      const depth = n - 1 - k;
      if (c.pop !== null) {
        // drops onto the pile from in front of the screen, so it shrinks to size as it falls, speeding up,
        // then turns softly into its resting angle
        if (c.pop === 0) { c.el.style.visibility = ''; if (k > 0 && P.dropShadow > 0) c.dropShadowEl = makeDropShadow(); }
        c.pop += dt;
        const target = stackZ(depth);
        c.sy = stackY(depth);
        let rx = 0, ry = 0, ox = 0, oy = 0;
        if (c.pop < P.dropFall) {
          const v = c.pop / P.dropFall, h = 1 - v * v;  // h: share of the height still to fall
          c.sz = target + c.dropFrom * h;
          // paper meeting air: a little sway and drift that dies out, flat by the time it lands
          rx = P.dropTilt * Math.sin(c.dropPhase + v * 5) * (1 - v);
          ry = P.dropTilt * Math.cos(c.dropPhase * 1.3 + v * 4) * (1 - v);
          ox = c.dropDrift[0] * h; oy = c.dropDrift[1] * h;
          c.focus.forEach(f => put(f, 'opacity', (P.dropBlur * Math.pow(1 - v, 1.5)).toFixed(2)));
          if (c.dropShadowEl) {
            // the shadow falls on the cover below, lit from the upper left: offset and soft while the cover is
            // high, sliding in under it and darkening as it lands
            const off = h * P.size * 0.3, sc = 1 + 0.3 * h;
            put(c.dropShadowEl, 'transform', `translate3d(${off.toFixed(1)}px,${(stackY(depth) + off).toFixed(1)}px,${(stackZ(depth + 1) + P.thick / 2 + 0.3).toFixed(1)}px) scale(${sc.toFixed(3)})`);
            put(c.dropShadowEl, 'opacity', (P.dropShadow * (0.15 + 0.75 * (1 - h))).toFixed(2));
          }
        } else {
          if (!c.landed) {
            // impact: the shadow goes, the focus is sharp, and the covers below give a little under the weight
            c.landed = true; c.impact = 0;
            if (c.dropShadowEl) { c.dropShadowEl.remove(); c.dropShadowEl = null; }
            c.focus.forEach(f => put(f, 'opacity', '0'));
            for (let j = 0; j < k; j++) if (cards[j].pop === null) cards[j].svz -= P.dropImpact * 90 / (1 + (k - 1 - j));
          }
          c.impact += dt;
          const v = Math.min(1, (c.pop - P.dropFall) / P.dropSettle);
          c.sz = target;
          c.s = 1 - 0.035 * P.dropImpact * Math.sin(Math.PI * Math.min(1, c.impact / 0.18));
          c.rz = c.landRz + (c.restRz - c.landRz) * (1 - Math.pow(1 - v, 3));
          if (v >= 1) { c.pop = null; c.rz = c.restRz; c.s = 1; c.svy = c.svz = 0; }
        }
        c.x = ox; c.y = c.sy + oy; c.z = c.sz;
        c.R = eulerMatrix(rx, ry, c.rz);
        return;
      }
      [c.sy, c.svy] = spring(c.sy, c.svy, stackY(depth), 260, 16, dt);
      [c.sz, c.svz] = spring(c.sz, c.svz, stackZ(depth), 260, 14, dt);
      [c.s, c.sv] = spring(c.s, c.sv, 1, 420, 13, dt);
      [c.srx, c.svrx] = spring(c.srx, c.svrx, 0, 220, 9, dt);
      stepBend(c, 0, 0, dt);
      c.x = 0; c.y = c.sy; c.z = c.sz; c.rx = c.srx; c.ry = 0;
      c.R = eulerMatrix(c.rx, c.ry, c.rz);
      if (c.lift) {
        const [kx, ky] = c.lift.corner, sign = c.lift.sign, f = liftAmount(c, dt);
        // the pinned point, halfway from the cover's centre to the chosen corner, as the cover lies on the pile
        const g = c.rz * DEG, half = P.size / 4;
        const px = (kx * Math.cos(g) - ky * Math.sin(g)) * half, py = (kx * Math.sin(g) + ky * Math.cos(g)) * half;
        // swing the centre around that corner, flat on screen, and rise toward the viewer
        const turn = f * P.nudge * P.nudgeTurn * sign, a = turn * DEG;
        c.x += px + (-px * Math.cos(a) + py * Math.sin(a));
        c.y += py + (-px * Math.sin(a) - py * Math.cos(a));
        c.z += f * P.nudge * P.nudgeLift;
        c.R = eulerMatrix(0, 0, c.rz + turn);
      }
    });
  }

  function stepPeel(c, dt) {
    const soft = 1 - P.hardness;
    c.t += dt;
    const u = clamp(c.t / c.peelDur, 0, 1), e = u * u;
    // the leading edge lifts toward you; a soft cover curls instead of tilting as a whole
    const rigid = 0.35 + 0.65 * P.hardness;
    c.rx = c.baseRx + c.dirY * P.peelTilt * e * rigid;
    c.ry = -c.dirX * P.peelTilt * e * rigid;
    c.bt = c.baseBt + soft * P.peelTilt * 0.55 * e; c.btv = 0;
    if (P.hardness < 0.999) { const k = bendK(); [c.bb, c.bbv] = spring(c.bb, c.bbv, 0, k, 2 * Math.sqrt(k) * 0.3, dt); }
    c.R = eulerMatrix(c.rx, c.ry, c.rz);
    // hinge on the trailing edge: the lowest point of the tilted card rises clear of the cover underneath
    const h = c.body.h, R = c.R;
    const reach = h[0] * Math.abs(R[2][0]) + h[1] * Math.abs(R[2][1]) + h[2] * Math.abs(R[2][2]);
    c.x = -c.dirX * 6 * e;
    c.y = c.baseY - c.dirY * 6 * e;
    c.z = Math.max(c.baseZ + 30 * e, e * (reach + h[2] + 1));
    [c.s, c.sv] = spring(c.s, c.sv, 1 - 0.012 * P.squash, 600, 20, dt);
    const np = [c.x, c.y, c.z];
    c.body.v = dt > 0 ? scale(sub(np, c.body.p), 1 / dt) : [0, 0, 0];
    c.body.p = np; c.body.R = c.R;
    if (u >= 1) {
      c.state = 'fly'; c.t = 0;
      releaseBody(c);
      c.sv += P.squash;
      c.btv = -soft * 300;  // the curled edge whips back when it lets go
    }
  }

  // one fixed physics step for everything in the air
  function physicsStep(dt) {
    const bodies = flying.filter(c => c.state === 'fly').map(c => c.body);
    for (const b of bodies) {
      const c = b.card;
      c.t += dt;
      const sp = Math.hypot(b.v[0], b.v[1]);
      // calm goes from 0 (just fired) to 1 (floating): flutter only takes over once the shot dies down
      const calm = clamp(1 - sp / (0.35 * c.v0), 0, 1);
      const calmE = calm * calm * (3 - 2 * calm);
      const wave = c.phase + c.t * c.hz * Math.PI * 2;
      b.v[0] += (-P.drag * sp * b.v[0] + P.flutter * calmE * Math.sin(wave)) * dt;
      b.v[1] += (P.gravity - P.drag * sp * b.v[1]) * dt;
      b.v[2] -= P.drag * 0.8 * Math.abs(b.v[2]) * b.v[2] * dt;
      // tumbling relaxes toward a lazy drift; the sway rocking rides on top of it
      const k = Math.exp(-P.spinDrag * dt);
      const base = sub(b.w, b.swayW).map((v, i) => b.drift[i] + (v - b.drift[i]) * k);
      const rate = c.hz * Math.PI * 2 * P.sway * DEG * calmE;
      b.swayW = mulMV(b.R, [0, rate * Math.cos(wave), -0.5 * rate * Math.sin(wave)]);
      b.w = add(base, b.swayW);
      b.p = add(b.p, b.v, dt);
      if (b.p[2] > 650) { b.p[2] = 650; b.v[2] = Math.min(b.v[2], 0); }
      b.q = integrateQuat(b.q, b.w, dt);
      b.R = quatMatrix(b.q);
    }
    const held = flying.filter(c => c.state === 'peel').map(c => c.body);
    const all = [...bodies, ...held, ...(stackBody ? [stackBody] : [])];
    for (let a = 0; a < all.length; a++) {
      for (let bI = a + 1; bI < all.length; bI++) {
        const A = all[a], B = all[bI];
        if (A.invMass === 0 && B.invMass === 0) continue;
        const reach = A.rad + B.rad;
        const d = sub(B.p, A.p);
        if (dot(d, d) > reach * reach) continue;
        let hit = satBoxes(A, B);
        // a cover that just left the pile is pushed out through its front face, so it cannot snag on the edges
        if (hit && B === stackBody && A.card.state === 'fly' && A.card.t < 0.3) hit = pileContact(A, B);
        if (hit) { maxDepth = Math.max(maxDepth, hit.depth); resolve(A, B, hit, P, onHit); }
      }
    }
  }

  function onHit(A, B, j) {
    const soft = 1 - P.hardness;
    for (const [b, s] of [[A, 1], [B, -1]]) {
      const c = b.card;
      if (!c) continue;
      c.sv -= Math.min(j * 0.003, 1.2) * P.squash;
      c.btv += s * j * soft * 0.25; c.bbv -= s * j * soft * 0.2;
    }
  }

  function syncFlying(dt, H, ay) {
    const soft = 1 - P.hardness;
    for (const c of flying) {
      if (c.state !== 'fly') continue;
      const b = c.body;
      c.x = b.p[0]; c.y = b.p[1]; c.z = b.p[2]; c.R = b.R;
      // air pushes on the face: the edges bend away from the direction of travel, and ripple while floating
      const nrm = col(b.R, 2);
      const vn = dot(b.v, nrm) / 600;
      const push = -clamp(vn, -1, 1) * MAX_BEND * soft;
      const calm = clamp(1 - Math.hypot(b.v[0], b.v[1]) / (0.35 * c.v0), 0, 1);
      const wave = c.phase + c.t * c.hz * Math.PI * 2;
      const ripple = MAX_BEND * 0.45 * soft * calm * calm * (3 - 2 * calm);
      stepBend(c, push + ripple * Math.sin(wave), push + ripple * Math.sin(wave + 1.9), dt);
      [c.s, c.sv] = spring(c.s, c.sv, 1, 380, 9, dt);
      // gone once the whole cover is below the bottom of the screen, as drawn with perspective
      const sc = 1000 / Math.max(200, 1000 - c.z);
      if (ay + (c.y - P.size * 0.75) * sc > H || c.t > 14) c.dead = true;
    }
    flying = flying.filter(c => { if (c.dead) c.el.remove(); return !c.dead; });
  }

  // ----- render -----
  // Only touch the DOM when a value actually changes: a resting pile then costs nothing per frame.
  function put(el, prop, v) {
    if (el['_' + prop] === v) return;
    el['_' + prop] = v;
    el.style[prop] = v;
  }

  // light falling on a surface whose normal is tilted by phi (radians) inside the card
  function lightAt(R, phi) {
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const n0 = -R[0][1] * sp + R[0][2] * cp, n1 = -R[1][1] * sp + R[1][2] * cp, n2 = -R[2][1] * sp + R[2][2] * cp;
    const lit = n0 * LIGHT[0] + n1 * LIGHT[1] + n2 * LIGHT[2];
    const spec = Math.pow(Math.max(0, 2 * lit * n2 - LIGHT[2]), P.shininess);  // reflected light toward the viewer
    // rounded to 1/40 steps: finer than the eye can tell apart, coarse enough that most frames need no repaint
    const q = v => (Math.round(clamp(v, 0, 0.7) * 40) / 40).toFixed(3);
    return { front: q(0.7 - lit * 0.75 - spec * 0.3), back: q(0.8 + lit * 0.75), spec };  // the back is 0.1 darker, so it reads as the back
  }

  const f4 = v => (Math.round(v * 10000) / 10000).toString();
  let frameNo = 0;
  function render(c, k) {
    const R = c.R;
    // squash never grows the card past its collision box; below 0.8 it is the pop-in, so scale evenly
    const popping = c.s < 0.8;
    const sx = popping ? c.s : Math.min(c.s, 1.03), sy = popping ? c.s : Math.min(2 - c.s, 1.03);
    put(c.el, 'transform',
      `matrix3d(${f4(R[0][0])},${f4(R[1][0])},${f4(R[2][0])},0,${f4(R[0][1])},${f4(R[1][1])},${f4(R[2][1])},0,${f4(R[0][2])},${f4(R[1][2])},${f4(R[2][2])},0,${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)},1) scale(${sx.toFixed(3)},${sy.toFixed(3)})`);
    for (const s of c.segs) put(s.el, 'transform', `rotateX(${((s.up ? -c.bt : c.bb) * (s.k === 0 ? 0.5 : 1)).toFixed(2)}deg)`);
    // Repainting the light is the costly part, so each cover refreshes it every other frame, alternating
    // between covers; the shape still moves every frame. A resting cover is refreshed whenever it changes.
    if (c.state !== 'stack' && (frameNo + k) % 2) return;
    const w = P.size, gx = Math.round((-R[0][2] * 0.7 + R[1][2] * 0.35) * w / 3) * 3;
    // Shading is worked out at the strip boundaries and blended across each strip,
    // so a bend reads as one smooth curve instead of bands with dark lines between them.
    const edgeAngle = (up, j) => (j === 0 ? (c.bb - c.bt) / 4 : (up ? -c.bt : c.bb) * j) * DEG;
    const lights = { up: [], down: [] };
    for (const up of [true, false]) for (let j = 0; j <= HALF; j++) lights[up ? 'up' : 'down'].push(lightAt(R, edgeAngle(up, j)));
    for (const s of c.segs) {
      const L = lights[s.up ? 'up' : 'down'], inner = L[s.k], outer = L[s.k + 1];
      const dir = s.up ? 'to top' : 'to bottom';
      put(s.fShade, 'backgroundImage', `linear-gradient(${dir}, rgba(0,0,0,${inner.front}), rgba(0,0,0,${outer.front}))`);
      put(s.bShade, 'backgroundImage', `linear-gradient(${dir}, rgba(0,0,0,${inner.back}), rgba(0,0,0,${outer.back}))`);
      put(s.fSpec, 'opacity', (Math.round(P.reflection * (0.25 + 0.75 * (inner.spec + outer.spec) / 2) * 40) / 40).toFixed(3));
      put(s.fSpec, 'backgroundPosition', `${-w / 2 + gx}px ${-w / 2 - s.segTop}px`);
    }
  }

  let last = performance.now();
  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.033, (now - last) / 1000) * timeScale;
    last = now;
    const { x: ax, y: ay } = anchor();
    put(world, 'transform', `translate3d(${Math.round(ax)}px,${Math.round(ay)}px,0)`);
    put(stage, 'perspectiveOrigin', `${Math.round(ax)}px ${Math.round(ay)}px`);
    stepStack(dt);
    charge += ((charging ? 1 : 0) - charge) * (1 - Math.exp(-dt * (charging ? 14 : 5)));
    pileShift *= Math.exp(-dt * 5);
    updateStackBody(dt);
    for (const c of flying) if (c.state === 'peel') stepPeel(c, dt);
    stepSequence(dt);
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 10) { physicsStep(STEP); acc -= STEP; steps++; }
    if (steps === 10) acc = 0;
    syncFlying(dt, window.innerHeight, ay);
    if (playIn >= 0) { playIn -= dt; if (playIn < 0) tap(); }
    put(stage, 'pointerEvents', shielded() ? 'auto' : 'none');
    // the pile builds back up once refillPause has passed and the last cover has left the screen
    if (restackIn >= 0 && !seq && flying.every(c => c.state === 'fly')) {
      restackIn = Math.max(0, restackIn - dt);
      if (restackIn === 0 && flying.length === 0) restack(true);
    }
    if (P.nudge > 0 && !seq && flying.length === 0) {
      nextNudge -= dt;
      if (nextNudge <= 0) { nudgeTop(); nextNudge = P.nudgeEvery * rand(0.7, 1.3); }
    } else nextNudge = Math.max(nextNudge, 2);
    frameNo++;
    cards.forEach(render);
    flying.forEach(render);
    requestAnimationFrame(frame);
  }

  restack();
  requestAnimationFrame(frame);

  return {
    fire: tap,
    nudge: () => nudgeTop(),
    restack: () => restack(),
    setCovers(next) { images = next.slice(); restack(); },
    setParams(next) {
      const rebuild = STRUCTURAL.some(k => next[k] !== undefined && next[k] !== P[k]);
      P = { ...P, ...next };
      if (rebuild) restack(); else updateStackBody();
    },
    setTimeScale(s) { timeScale = s; },
    setOnePerTap(on) { onePerTap = on; },
    get maxOverlap() { return maxDepth; },
    get remaining() { return cards.length; },
    get busy() { return !!seq || flying.length > 0; },
    destroy() { alive = false; stage.innerHTML = ''; stage.style.pointerEvents = 'none'; }
  };
}
