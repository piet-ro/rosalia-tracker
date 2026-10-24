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
  size: 125, thick: 2, radius: 10, stackGap: 1, jitter: 3,
  hardness: 0.4, reflection: 0.2, shininess: 10, squash: 6,
  peel: 0.16, peelTilt: 38,
  power: 990, spread: 75, zKick: 400,
  gravity: 650, drag: 0.006, flutter: 320, flutterHz: 1.2, sway: 38,
  spin: 500, spinDrag: 1.8, settleSpin: 90,
  bounce: 0.6, friction: 0.3,
  burstStart: 0.34, burstAccel: 0.82, burstMin: 0.05,
  nudge: 0.8, nudgeEvery: 4
};

const STRUCTURAL = ['size', 'thick', 'radius', 'jitter'];
const DEG = Math.PI / 180;
const SEG = 6, HALF = SEG / 2;
const MAX_BEND = 28;
const STEP = 1 / 240;
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
  const T = sub(B.p, A.p);
  const axesA = [0, 1, 2].map(i => col(A.R, i)), axesB = [0, 1, 2].map(i => col(B.R, i));
  const cands = [...axesA, ...axesB];
  for (const a of axesA) for (const b of axesB) {
    const c = cross(a, b), m = Math.hypot(...c);
    if (m > 1e-3) cands.push(scale(c, 1 / m));
  }
  let best = null;
  cands.forEach((L, idx) => {
    const rA = A.h[0] * Math.abs(dot(axesA[0], L)) + A.h[1] * Math.abs(dot(axesA[1], L)) + A.h[2] * Math.abs(dot(axesA[2], L));
    const rB = B.h[0] * Math.abs(dot(axesB[0], L)) + B.h[1] * Math.abs(dot(axesB[1], L)) + B.h[2] * Math.abs(dot(axesB[2], L));
    const d = dot(T, L);
    let overlap = rA + rB - Math.abs(d);
    if (best === false) return;
    if (overlap <= 0) { best = false; return; }
    const ranked = idx < 6 ? overlap : overlap * 1.05 + 0.1;  // prefer face contacts for stability
    if (!best || ranked < best.ranked) best = { ranked, depth: overlap, n: d < 0 ? scale(L, -1) : L };
  });
  return best || null;
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
  const corr = Math.min(Math.max(hit.depth - 0.3, 0) * 0.35, 2.5) / totalInv;
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
const backCache = {};
function defaultBack(w) {
  if (backCache[w]) return backCache[w];
  const cv = document.createElement('canvas'); const s = 2;
  cv.width = cv.height = w * s;
  const g = cv.getContext('2d'); g.scale(s, s);
  g.fillStyle = '#2c2c2c'; g.fillRect(0, 0, w, w);
  g.strokeStyle = '#3e3e3e'; g.lineWidth = 6;
  for (let x = -w; x < 2 * w; x += 12) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + w, w); g.stroke(); }
  return (backCache[w] = cv.toDataURL());
}

// ---------- the stack ----------
export function createPeelStack({ stage, anchor, covers = [], params = {}, back = null, edge = '#9a9a94', onTopTap = null }) {
  let P = { ...DEFAULTS, ...params };
  let images = covers.slice();
  let cards = [], flying = [];
  let timeScale = 1, onePerTap = false, burstTimer = null, nextNudge = 3, alive = true, acc = 0;
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
    .ps-seg { left: 0; }
    .ps-face { position: absolute; inset: 0; backface-visibility: hidden; overflow: hidden; background-repeat: no-repeat; }
    .ps-shade, .ps-spec { position: absolute; inset: 0; pointer-events: none; }
    .ps-shade { background: #000; opacity: 0; }
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
    const front = images[i], backImg = back || defaultBack(w);
    const c = {
      el: root, i, segs: [],
      x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: rand(-P.jitter, P.jitter),
      sy: 0, svy: 0, sz: 0, svz: 0, s: 1, sv: 0, srx: 0, svrx: 0,
      bt: 0, btv: 0, bb: 0, bbv: 0,  // bend per joint (deg) of the top and bottom halves
      state: 'stack'
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
        // faces overlap the next strip by 1.5px so no seam shows between strips
        const bg = `bottom:-1.5px;background-size:${w}px ${w}px;background-position:0 ${-segTop}px;border-radius:${rad}`;
        const f = mk(seg, 'ps-face', `${bg};background-image:url("${front}");transform:translateZ(${t / 2}px)`);
        const fShade = mk(f, 'ps-shade', '');
        const fSpec = mk(f, 'ps-spec', `background-size:${2 * w}px ${2 * w}px`);
        const b = mk(seg, 'ps-face', `${bg};background-image:url("${backImg}");transform:rotateY(180deg) translateZ(${t / 2}px)`);
        const bShade = mk(b, 'ps-shade', '');
        if (t > 0) {
          const eTop = outer && up ? r : 0, eH = hS - (outer ? r : 0);
          mk(seg, 'ps-edge', `background:${edge};width:${t}px;height:${eH}px;left:${-t / 2}px;top:${eTop}px;transform:rotateY(-90deg)`);
          mk(seg, 'ps-edge', `background:${edge};width:${t}px;height:${eH}px;left:${w - t / 2}px;top:${eTop}px;transform:rotateY(90deg)`);
          if (outer) mk(seg, 'ps-edge', `background:${edge};width:${w - 2 * r}px;height:${t}px;left:${r}px;top:${up ? -t / 2 : hS - t / 2}px;transform:rotateX(${up ? 90 : -90}deg)`);
        }
        c.segs.push({ el: seg, up, k, segTop, fShade, fSpec, bShade });
        parent = seg;
      }
    }
    root.addEventListener('pointerdown', e => {
      if (c.state !== 'stack' || c !== cards[cards.length - 1]) return;
      e.preventDefault(); tap();
    });
    root.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && c === cards[cards.length - 1]) { e.preventDefault(); tap(); }
    });
    world.appendChild(root);
    return c;
  }

  const stackY = d => d * P.stackGap;
  const stackZ = d => -d * (P.thick + 0.5);

  function markTop() {
    cards.forEach((c, k) => {
      const top = k === cards.length - 1;
      c.el.classList.toggle('ps-top', top);
      if (top) { c.el.tabIndex = 0; c.el.setAttribute('role', 'button'); c.el.setAttribute('aria-label', 'Throw the streak covers'); }
      else { c.el.removeAttribute('tabindex'); c.el.removeAttribute('role'); c.el.removeAttribute('aria-label'); }
    });
    updateStackBody();
  }

  // the resting pile is one immovable box, so falling covers bump off it instead of passing through
  function updateStackBody() {
    if (!cards.length) { stackBody = null; return; }
    const n = cards.length, w = P.size;
    const zTop = P.thick / 2, zBot = stackZ(n - 1) - P.thick / 2;
    stackBody = {
      p: [0, stackY(n - 1) / 2, (zTop + zBot) / 2], v: [0, 0, 0], w: [0, 0, 0],
      R: eulerMatrix(0, 0, 0), h: [w / 2, w / 2 + stackY(n - 1) / 2, (zTop - zBot) / 2],
      invMass: 0, invI: [0, 0, 0], card: null
    };
  }

  function restack() {
    clearTimeout(burstTimer); burstTimer = null;
    world.innerHTML = ''; flying = []; maxDepth = 0;
    cards = images.map((_, i) => buildCard(i));
    const n = cards.length;
    cards.forEach((c, k) => {  // pop-in cascade from the bottom up
      const depth = n - 1 - k;
      c.sy = stackY(depth); c.sz = stackZ(depth) - 60;
      c.s = 0.0001; c.sv = 0; c.delay = k * 0.018;
    });
    markTop();
    nextNudge = 2.5;
  }

  // ----- interaction -----
  function tap() {
    if (onTopTap) onTopTap();
    if (burstTimer) return;
    if (cards.length <= 1) { restack(); return; }
    if (onePerTap) { if (launchClear()) launchTop(); return; }
    let gap = P.burstStart;
    const step = () => {
      if (cards.length <= 1) { burstTimer = null; return; }
      if (!launchClear()) { burstTimer = setTimeout(step, 16); return; }
      gap = Math.max(P.burstMin, gap * P.burstAccel);
      launchTop(gap * 0.9);
      burstTimer = setTimeout(step, (gap * 1000) / timeScale);
    };
    step();
  }

  // The next cover can only peel once the space it lifts into is empty.
  function launchClear() {
    const [hx, , hz] = boxHalf(), lift = P.size * 0.35;
    const space = { p: [0, 0, lift / 2 + hz], R: eulerMatrix(0, 0, 0), h: [hx, hx, lift / 2 + hz] };
    return flying.every(f => f.state === 'fly' && !satBoxes(f.body, space));
  }

  // A cover finishes peeling before the next one starts, so two peeling covers never pass through each other.
  function launchTop(maxPeel = Infinity) {
    for (const f of flying) if (f.state === 'peel') f.peelDur = Math.min(f.peelDur, f.t);
    const c = cards.pop();
    if (!c) return;
    const ang = (-90 + rand(-P.spread / 2, P.spread / 2)) * DEG;
    Object.assign(c, {
      state: 'peel', t: 0, peelDur: Math.max(0.02, Math.min(P.peel, maxPeel)),
      dirX: Math.cos(ang), dirY: Math.sin(ang), v0: P.power * rand(0.8, 1.2),
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
    c.body = { p: [c.x, c.y, c.z], v: [0, 0, 0], w: [0, 0, 0], R: c.R, h: boxHalf(), invMass: 0, invI: [0, 0, 0], card: c };
  }

  function releaseBody(c) {
    const b = c.body, m = 1, [hx, , hz] = b.h;
    Object.assign(b, {
      v: [c.dirX * c.v0, c.dirY * c.v0, P.zKick * rand(0.15, 1)],  // off the pile, so always toward you
      q: matrixQuat(c.R),
      w: [rand(-1, 1) * P.spin * DEG, rand(-1, 1) * P.spin * DEG, rand(-0.5, 0.5) * P.spin * DEG],
      invMass: 1 / m,
      invI: [12 / (m * (4 * hx * hx + 4 * hz * hz)), 12 / (m * (4 * hx * hx + 4 * hz * hz)), 12 / (m * 8 * hx * hx)],
      drift: [rand(-1, 1), rand(-1, 1), rand(-1, 1)].map(v => v * P.settleSpin * DEG),
      swayW: [0, 0, 0]
    });
    b.R = quatMatrix(b.q);
  }

  function nudgeTop() {
    const c = cards[cards.length - 1];
    if (!c || c.delay > 0) return;
    const a = P.nudge, soft = 1 - P.hardness;
    c.svrx -= a * rand(70, 110);         // tip the top edge toward you
    c.btv += a * soft * rand(120, 200);   // and curl it a little if it is soft
    c.sv -= a * 1.2;
    c.svz += a * 60;
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
      if (c.delay > 0) { c.delay -= dt; if (c.delay <= 0) c.sv = 9; return; }
      const depth = n - 1 - k;
      [c.sy, c.svy] = spring(c.sy, c.svy, stackY(depth), 260, 16, dt);
      [c.sz, c.svz] = spring(c.sz, c.svz, stackZ(depth), 260, 14, dt);
      [c.s, c.sv] = spring(c.s, c.sv, 1, 420, 13, dt);
      [c.srx, c.svrx] = spring(c.srx, c.svrx, 0, 220, 9, dt);
      stepBend(c, 0, 0, dt);
      c.x = 0; c.y = c.sy; c.z = c.sz; c.rx = c.srx; c.ry = 0;
      c.R = eulerMatrix(c.rx, c.ry, c.rz);
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
        const reach = Math.hypot(...A.h) + Math.hypot(...B.h);
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
      if (ay + c.y > H + P.size * 1.5 || c.t > 14) c.dead = true;
    }
    flying = flying.filter(c => { if (c.dead) c.el.remove(); return !c.dead; });
  }

  // ----- render -----
  function render(c) {
    const R = c.R;
    // squash never grows the card past its collision box; below 0.8 it is the pop-in, so scale evenly
    const popping = c.s < 0.8;
    const sx = popping ? c.s : Math.min(c.s, 1.03), sy = popping ? c.s : Math.min(2 - c.s, 1.03);
    c.el.style.transform =
      `matrix3d(${R[0][0]},${R[1][0]},${R[2][0]},0,${R[0][1]},${R[1][1]},${R[2][1]},0,${R[0][2]},${R[1][2]},${R[2][2]},0,${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)},1) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
    const nc = col(R, 2);
    const w = P.size, gx = (-nc[0] * 0.7 + nc[1] * 0.35) * w;
    for (const s of c.segs) {
      const joint = s.k === 0 ? 0.5 : 1;
      const b = s.up ? -c.bt * joint : c.bb * joint;
      s.el.style.transform = `rotateX(${b.toFixed(2)}deg)`;
      const phi = (s.up ? -c.bt * (0.5 + s.k) : c.bb * (0.5 + s.k)) * DEG;
      const n = mulMV(R, [0, -Math.sin(phi), Math.cos(phi)]);
      const lit = dot(n, LIGHT);
      const rz2 = 2 * lit * n[2] - LIGHT[2];  // reflected light toward the viewer
      const spec = Math.pow(Math.max(0, rz2), P.shininess);
      s.fShade.style.opacity = clamp(0.7 - lit * 0.75 - spec * 0.3, 0, 0.6).toFixed(3);
      s.bShade.style.opacity = clamp(0.7 + lit * 0.75, 0, 0.6).toFixed(3);
      s.fSpec.style.opacity = (P.reflection * (0.25 + 0.75 * spec)).toFixed(3);
      s.fSpec.style.backgroundPosition = `${(-w / 2 + gx).toFixed(1)}px ${(-w / 2 - s.segTop).toFixed(1)}px`;
    }
  }

  let last = performance.now();
  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.033, (now - last) / 1000) * timeScale;
    last = now;
    const { x: ax, y: ay } = anchor();
    world.style.transform = `translate3d(${ax}px,${ay}px,0)`;
    stage.style.perspectiveOrigin = `${ax}px ${ay}px`;
    stepStack(dt);
    for (const c of flying) if (c.state === 'peel') stepPeel(c, dt);
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 10) { physicsStep(STEP); acc -= STEP; steps++; }
    if (steps === 10) acc = 0;
    syncFlying(dt, window.innerHeight, ay);
    if (P.nudge > 0 && !burstTimer && flying.length === 0) {
      nextNudge -= dt;
      if (nextNudge <= 0) { nudgeTop(); nextNudge = P.nudgeEvery * rand(0.7, 1.3); }
    } else nextNudge = Math.max(nextNudge, 2);
    cards.forEach(render);
    flying.forEach(render);
    requestAnimationFrame(frame);
  }

  restack();
  requestAnimationFrame(frame);

  return {
    fire: tap,
    restack,
    setCovers(next) { images = next.slice(); restack(); },
    setParams(next) {
      const rebuild = STRUCTURAL.some(k => next[k] !== undefined && next[k] !== P[k]);
      P = { ...P, ...next };
      if (rebuild) restack(); else updateStackBody();
    },
    setTimeScale(s) { timeScale = s; },
    setOnePerTap(on) { onePerTap = on; },
    get maxOverlap() { return maxDepth; },
    get busy() { return !!burstTimer || flying.length > 0; },
    destroy() { alive = false; clearTimeout(burstTimer); stage.innerHTML = ''; }
  };
}
