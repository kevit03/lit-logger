// LIT popup module: buddy-roam.
//
// The buddy leaves its seat beside the counter and roams the board like a
// little desktop pet. It walks along the top edges of the cards, hops between
// them, runs when something good happens, waves when a break is due, and naps
// when things go quiet. It can be picked up and dropped anywhere.
//
// The parts that decide where to go (edges from rectangles, routes, hop arcs,
// facing, bubble side, idle choices, falling) are pure and exported for
// tests. The DOM part moves #buddy into #buddy-layer (popup.js keeps updating
// it by id), measures the live layout, and runs at most one
// requestAnimationFrame loop, only while the buddy is actually moving.
//
// Talks to the popup only through window.LitPopup (see popup/bridge.js).
const BuddyRoam = (() => {
  // The roaming buddy box, and where its feet touch down inside it.
  const SIZE = { w: 36, h: 40, foot: 39 };
  const HALF = SIZE.w / 2;
  const PACE = { walk: 52, run: 175 };     // px per second
  const GRAVITY = 1500;                     // px per second squared
  const NAP_AFTER = 60000;                  // quiet time before a nap
  const IDLE_MIN = 8000;
  const IDLE_SPAN = 7000;
  const MAX_UP = 150;                       // taller climbs go edge by edge
  const MAX_DOWN = 230;
  const MAX_HOP_DX = 130;                   // walk first so hops stay short
  const EDGE_INSET = 10;                    // keep off the rounded corners
  const BUBBLE_MS = 4500;
  const FLING_SPEED = 520;
  // Every pose the module puts in data-action; buddy-roam.css styles them.
  const ACTIONS = ['stand', 'walk', 'run', 'crouch', 'hop', 'land', 'sit', 'look', 'wave', 'cheer',
    'shrug', 'peek', 'yawn', 'nap', 'stretch', 'dangle', 'tumble', 'dizzy'];

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function mergeIntervals(list) {
    const sorted = (list || []).filter(i => i && i[1] > i[0]).map(i => [i[0], i[1]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    sorted.forEach(i => {
      const last = out[out.length - 1];
      if (last && i[0] <= last[1]) last[1] = Math.max(last[1], i[1]);
      else out.push(i);
    });
    return out;
  }

  // [lo, hi] minus the blocked intervals.
  function freeIntervals(lo, hi, blocked) {
    if (!(hi >= lo)) return [];
    let segs = [[lo, hi]];
    mergeIntervals(blocked).forEach(b => {
      const next = [];
      segs.forEach(s => {
        if (b[1] <= s[0] || b[0] >= s[1]) { next.push(s); return; }
        if (b[0] > s[0]) next.push([s[0], b[0]]);
        if (b[1] < s[1]) next.push([b[1], s[1]]);
      });
      segs = next;
    });
    return segs;
  }

  // Where the buddy's center may NOT stand on an edge at height y, because
  // its body would cover a control.
  function blockedFor(y, obstacles, size) {
    const s = size || SIZE;
    const half = s.w / 2;
    const top = y - s.foot + 4;
    const bottom = y - 2;
    const out = [];
    (obstacles || []).forEach(r => {
      if (!r || !(r.right > r.left) || !(r.bottom > r.top)) return;
      if (r.bottom <= top || r.top >= bottom) return;
      out.push([r.left - half - 2, r.right + half + 2]);
    });
    return mergeIntervals(out);
  }

  // Walkable edges from rectangles in layer coordinates.
  // items: [{ key, kind, rect: {left, top, right, bottom} }]
  // A perch: { key, kind, x1, x2 (the edge), lo, hi (where the center can
  // be), y (where the feet stand), free: [[a, b]...] (spots off controls) }.
  function buildPerches(items, obstacles, size) {
    const s = size || SIZE;
    const half = s.w / 2;
    const out = [];
    (items || []).forEach(it => {
      const r = it && it.rect;
      if (!r || !(r.right - r.left > 0) || !(r.bottom - r.top > 0)) return;
      // The seat beside the ring has square ends; cards have rounded corners.
      const inset = it.kind === 'floor' ? 0 : (it.kind === 'seat' ? 2 : EDGE_INSET);
      const x1 = r.left + inset;
      const x2 = r.right - inset;
      const lo = x1 + half;
      const hi = x2 - half;
      if (hi < lo) return;
      // The feet sit on the border line so the buddy looks planted.
      const y = Math.round(r.top) + 1;
      const p = { key: String(it.key), kind: it.kind || 'card', x1, x2, lo, hi, y };
      p.free = freeIntervals(lo, hi, blockedFor(y, obstacles, s));
      out.push(p);
    });
    return out;
  }

  function isFree(p, x) {
    return !!p && (p.free || []).some(i => x >= i[0] - 0.5 && x <= i[1] + 0.5);
  }

  // The free spot on an edge closest to `want`, or null if the edge is all
  // controls.
  function bestX(p, want) {
    let best = null;
    let dist = Infinity;
    ((p && p.free) || []).forEach(i => {
      const x = clamp(want, i[0], i[1]);
      const d = Math.abs(x - want);
      if (d < dist) { dist = d; best = x; }
    });
    return best;
  }

  function inView(p, view, size) {
    const s = size || SIZE;
    return !!p && !!view && p.y - s.foot >= view.top - 0.5 && p.y <= view.bottom + 0.5;
  }

  // Reading order: top to bottom, then left to right.
  function perchOrder(perches) {
    return (perches || []).slice().sort((a, b) => (a.y - b.y) || (a.x1 - b.x1));
  }

  // The previous (dir -1) or next (dir 1) edge from where the buddy is.
  function neighborPerch(perches, key, x, y, dir) {
    const list = perchOrder((perches || []).filter(p => p.kind !== 'floor' && p.free && p.free.length));
    const i = list.findIndex(p => p.key === key);
    if (i >= 0) return list[i + dir] || null;
    if (dir > 0) return list.find(p => p.y > y + 2 || (Math.abs(p.y - y) <= 2 && p.x1 > x)) || null;
    const before = list.filter(p => p.y < y - 2 || (Math.abs(p.y - y) <= 2 && p.x2 < x));
    return before[before.length - 1] || null;
  }

  // A route from where the buddy is to a spot on an edge, as legs:
  //   { type: 'walk', key, x0, x1, y }
  //   { type: 'hop', key, x0, y0, x1, y1 }
  // Tall climbs and long drops go edge by edge; long hops walk first.
  function planRoute(perches, from, to, opts) {
    const o = Object.assign({ maxUp: MAX_UP, maxDown: MAX_DOWN, maxDx: MAX_HOP_DX }, opts);
    const list = perches || [];
    const byKey = k => (k == null ? null : list.find(p => p.key === k) || null);
    const goal = byKey(to && to.key);
    if (!goal || !from) return [];
    const tx = clamp(to.x, goal.lo, goal.hi);
    const legs = [];
    let x = from.x;
    let y = from.y;
    let at = byKey(from.key);
    for (let guard = 0; guard < 8 && (!at || at.key !== goal.key); guard++) {
      let next = goal;
      const climb = y - goal.y;
      if (climb > o.maxUp || -climb > o.maxDown) {
        const up = climb > 0;
        const reach = up ? o.maxUp : o.maxDown;
        const between = list.filter(p => p !== goal && p !== at && p.kind !== 'floor' &&
          (up ? (p.y < y - 24 && p.y > goal.y + 24) : (p.y > y + 24 && p.y < goal.y - 24)) &&
          p.hi >= Math.min(x, tx) - 160 && p.lo <= Math.max(x, tx) + 160);
        // The farthest edge within reach; if none is (a tall card), the nearest one on the way.
        const inReach = between.filter(p => Math.abs(p.y - y) <= reach);
        if (inReach.length) next = inReach.reduce((a, b) => (Math.abs(b.y - y) > Math.abs(a.y - y) ? b : a));
        else if (between.length) next = between.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a));
      }
      const landWant = clamp(next === goal ? tx : x + (tx - x) * 0.5, next.lo, next.hi);
      let takeoff = x;
      if (at && Math.abs(landWant - x) > o.maxDx) {
        takeoff = clamp(landWant > x ? landWant - o.maxDx : landWant + o.maxDx, at.lo, at.hi);
        if (Math.abs(takeoff - x) > 1) legs.push({ type: 'walk', key: at.key, x0: x, x1: takeoff, y: at.y });
        else takeoff = x;
      }
      // Land within reach and walk the rest.
      let land = landWant;
      if (Math.abs(land - takeoff) > o.maxDx) land = clamp(takeoff + Math.sign(land - takeoff) * o.maxDx, next.lo, next.hi);
      legs.push({ type: 'hop', key: next.key, x0: takeoff, y0: y, x1: land, y1: next.y });
      x = land;
      y = next.y;
      at = next;
    }
    if (at && at.key === goal.key && Math.abs(tx - x) > 1) legs.push({ type: 'walk', key: goal.key, x0: x, x1: tx, y: goal.y });
    return legs;
  }

  // A hop is y(t) = y0 + (y1 - y0) t - k t (1 - t) with t linear in time,
  // which is a true ballistic arc. arcK picks k so the top of the arc is
  // `lift` px above the higher of the two ends.
  function arcK(y0, y1, lift) {
    const d = y1 - y0;
    const m = (y0 - Math.min(y0, y1)) + Math.max(0, lift || 0);
    return d + 2 * m + 2 * Math.sqrt(Math.max(0, m * m + d * m));
  }

  function arcPoint(x0, y0, x1, y1, k, t) {
    const u = clamp(t, 0, 1);
    return { x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u - k * u * (1 - u) };
  }

  // Seconds in the air for an arc with this k under gravity g.
  function hopDuration(k, g) {
    return clamp(Math.sqrt(2 * Math.max(0, k) / (g || GRAVITY)), 0.22, 0.95);
  }

  // How high to hop: a small bounce for drops, a bit more for long hops.
  function hopLift(x0, y0, x1, y1) {
    if (y1 > y0 + 40) return 10;
    return 14 + Math.min(22, Math.abs(x1 - x0) * 0.12);
  }

  function facingFor(dx, prev) {
    if (dx > 0.5) return 'right';
    if (dx < -0.5) return 'left';
    return prev === 'left' ? 'left' : 'right';
  }

  // Which side of the buddy the speech bubble opens to, and whether it sits
  // above the head or below the feet. Keeps the previous side while it fits.
  // o: { x, y (feet), width (board), top (visible top), bubbleW, bubbleH, prev }
  function bubblePlacement(o) {
    const s = o.size || SIZE;
    const pad = 6;
    const anchor = s.w * 0.12;
    const roomRight = o.width - pad - (o.x + anchor);
    const roomLeft = (o.x - anchor) - pad;
    const fits = side => (side === 'left' ? roomLeft : roomRight) >= o.bubbleW;
    let side;
    if ((o.prev === 'left' || o.prev === 'right') && fits(o.prev)) side = o.prev;
    else if (fits('right')) side = 'right';
    else if (fits('left')) side = 'left';
    else side = roomRight >= roomLeft ? 'right' : 'left';
    const headTop = o.y - s.foot;
    const vert = headTop - o.bubbleH - 2 >= o.top + 4 ? 'above' : 'below';
    // Text the bubble must not sit on (the counter's label, the headline...).
    // Try the usual pick first, then the other placements that fit.
    const avoid = Array.isArray(o.avoid) ? o.avoid : [];
    if (!avoid.length) return { side, vert };
    // 'beside' sits level with the buddy, clear of its body: the only spot
    // that fits between a label above and buttons below (the counter seat).
    const besideGap = s.w / 2 + 4;
    const sizeFor = (sd, vt) => {
      if (vt !== 'beside') return { w: o.bubbleW, h: o.bubbleH };
      const w = Math.min(o.bubbleW, Math.max(BESIDE_MIN, besideRoom(sd)));
      // The real height at that width when the caller can measure it;
      // otherwise a rough guess from how much narrower it got.
      if (typeof o.measureAt === 'function') {
        const mh = o.measureAt(w);
        if (mh > 0) return { w, h: mh };
      }
      return { w, h: o.bubbleH * Math.max(1, Math.ceil(o.bubbleW / w - 0.05)) };
    };
    const boxFor = (sd, vt) => {
      const off = vt === 'beside' ? besideGap : anchor;
      const { w, h } = sizeFor(sd, vt);
      const left = sd === 'right' ? o.x + off : o.x - off - w;
      const top = vt === 'above' ? headTop - 2 - h
        : (vt === 'below' ? o.y + 4 : o.y - s.foot / 2 - h / 2);
      return { left, right: left + w, top, bottom: top + h };
    };
    // Beside may wrap narrower (down to BESIDE_MIN px) and grow a line or two.
    const BESIDE_MIN = 120;
    const besideRoom = sd => (sd === 'left' ? (o.x - besideGap) - pad : o.width - pad - (o.x + besideGap));
    const fitsBeside = sd => besideRoom(sd) >= Math.min(o.bubbleW, BESIDE_MIN);
    // Overlap area with the protected rectangles; a rectangle marked
    // `weight` (buttons) counts more than plain text.
    const overlap = b => avoid.reduce((sum, r) => {
      const w = Math.min(b.right, r.right) - Math.max(b.left, r.left);
      const h = Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top);
      return w > 0 && h > 0 ? sum + w * h * (r.weight || 1) : sum;
    }, 0);
    const other = side === 'right' ? 'left' : 'right';
    const flip = vert === 'above' ? 'below' : 'above';
    const options = [[side, vert], [side, 'beside'], [side, flip], [other, vert], [other, 'beside'], [other, flip]]
      .filter(([sd, vt]) => vt === 'beside' ? fitsBeside(sd)
        : (sd === side || fits(sd)) && (vt === 'below' || headTop - o.bubbleH - 2 >= o.top + 4));
    // The first clear placement in order of preference; otherwise the one
    // that covers the least.
    let best = null;
    options.forEach(([sd, vt]) => {
      const cost = overlap(boxFor(sd, vt));
      if (!best || cost < best.cost) best = { side: sd, vert: vt, cost };
    });
    if (!best) return { side, vert };
    const out = { side: best.side, vert: best.vert };
    if (best.vert === 'beside') out.maxWidth = Math.round(sizeFor(best.side, 'beside').w);
    return out;
  }

  // What to do on an idle beat. o: { now, lastInteraction, last, nudge, rand }
  function idleDecision(o) {
    const rand = o.rand || Math.random;
    if (o.nudge) return 'wave';
    if (o.now - (o.lastInteraction || 0) >= NAP_AFTER) return 'nap';
    const r = rand();
    let kind = r < 0.42 ? 'wander' : (r < 0.64 ? 'look' : (r < 0.82 ? 'sit' : 'wave'));
    if (kind !== 'wander' && kind === o.last) kind = 'wander';
    return kind;
  }

  // Milliseconds until the next idle beat: 8 to 15 seconds, but never later
  // than the moment a nap is due.
  function idleDelay(o) {
    const rand = o.rand || Math.random;
    const base = IDLE_MIN + rand() * IDLE_SPAN;
    const untilNap = NAP_AFTER - (o.now - (o.lastInteraction || 0));
    if (untilNap <= 0) return 1200;
    return Math.round(Math.min(base, untilNap + 50));
  }

  function randomFreeX(p, rand, awayFrom, minGap) {
    const spans = (p.free || []).filter(i => i[1] >= i[0]);
    if (!spans.length) return null;
    for (let tries = 0; tries < 6; tries++) {
      const total = spans.reduce((n, i) => n + (i[1] - i[0]) + 1, 0);
      let r = rand() * total;
      let span = spans[spans.length - 1];
      for (let i = 0; i < spans.length; i++) {
        const w = spans[i][1] - spans[i][0] + 1;
        if (r < w) { span = spans[i]; break; }
        r -= w;
      }
      const x = span[0] + rand() * (span[1] - span[0]);
      if (awayFrom == null || Math.abs(x - awayFrom) >= minGap) return x;
    }
    return null;
  }

  // A place to wander to: often a new spot on the same edge, otherwise
  // another edge (closer ones likelier, the counter card and seat favorites).
  function pickWander(perches, cur, rand) {
    const rnd = rand || Math.random;
    const spots = (perches || []).filter(p => p.kind !== 'floor' && p.free && p.free.length);
    if (!spots.length) return null;
    const here = spots.find(p => p.key === cur.key) || null;
    if (here && rnd() < 0.5) {
      const x = randomFreeX(here, rnd, cur.x, 36);
      if (x !== null) return { key: here.key, x };
    }
    const others = spots.filter(p => p !== here);
    if (!others.length) {
      const x = here ? randomFreeX(here, rnd, cur.x, 24) : null;
      return x === null ? null : { key: here.key, x };
    }
    const weights = others.map(p => (p.kind === 'counter' || p.kind === 'seat' ? 1.6 : 1) / (1 + Math.abs(p.y - cur.y) / 140));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    let pick = others[others.length - 1];
    for (let i = 0; i < others.length; i++) {
      if (r < weights[i]) { pick = others[i]; break; }
      r -= weights[i];
    }
    const x = randomFreeX(pick, rnd, null, 0);
    return x === null ? null : { key: pick.key, x };
  }

  // If the buddy is covering a control (or is on no visible edge), the
  // nearest spot that is out of the way; null when it is fine where it is.
  function settleSpot(perches, cur) {
    const list = perches || [];
    const here = cur.key != null ? list.find(p => p.key === cur.key) : null;
    if (here && isFree(here, cur.x)) return null;
    if (here) {
      const x = bestX(here, cur.x);
      if (x !== null && Math.abs(x - cur.x) <= 160) return { key: here.key, x };
    }
    let best = null;
    let score = Infinity;
    list.forEach(p => {
      if (p === here) return;
      const x = bestX(p, cur.x);
      if (x === null) return;
      const s = Math.abs(p.y - cur.y) + Math.abs(x - cur.x) * 0.5 + (p.kind === 'floor' ? 400 : 0);
      if (s < score) { score = s; best = { key: p.key, x }; }
    });
    return best;
  }

  // One physics step for a dropped or flung buddy. bounds: { left, right, top }
  // limit where the feet may go; it bounces softly off the sides.
  function stepBody(b, dt, bounds, g) {
    let vx = b.vx || 0;
    let vy = (b.vy || 0) + (g || GRAVITY) * dt;
    let x = b.x + vx * dt;
    let y = b.y + vy * dt;
    if (x < bounds.left) { x = bounds.left; vx = Math.abs(vx) * 0.5; }
    else if (x > bounds.right) { x = bounds.right; vx = -Math.abs(vx) * 0.5; }
    if (y < bounds.top) { y = bounds.top; if (vy < 0) vy = -vy * 0.3; }
    vx *= Math.pow(0.5, dt);
    return { x, y, vx, vy, rot: (b.rot || 0) + (b.spin || 0) * dt, spin: b.spin || 0 };
  }

  // The first edge the feet cross on the way down, or null.
  function landingFor(perches, x, prevY, nextY) {
    if (!(nextY >= prevY)) return null;
    let best = null;
    (perches || []).forEach(p => {
      if (x < p.x1 || x > p.x2) return;
      if (p.y < prevY || p.y > nextY) return;
      if (!best || p.y < best.y) best = p;
    });
    return best;
  }

  // A point on a circle, clockwise from the top, with the rotation that keeps
  // the feet on the circle and the head pointing out.
  function orbitPoint(cx, cy, r, deg) {
    const a = deg * Math.PI / 180;
    return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a), rot: deg };
  }

  // Release velocity (px/s) from recent pointer samples [{x, y, t}].
  function flingVelocity(samples, nowT, windowMs) {
    const w = windowMs || 100;
    const recent = (samples || []).filter(s => nowT - s.t <= w);
    if (recent.length < 2) return { x: 0, y: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0.004) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  function easeInOut(u) {
    return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  }

  // ---------------------------------------------------------------------------
  // Runtime (the popup only)
  // ---------------------------------------------------------------------------
  const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="tab"], [role="button"], ' +
    '[role="switch"], [tabindex]:not([tabindex="-1"]), .ring-wrap';
  const NOTE_CARDS = ['merge-card', 'milestone-card', 'first-run-card', 'digest-card', 'tip-card'];

  const S = {
    inited: false, on: false, blocked: false, needsEntrance: false, goalPending: 0,
    box: null, btn: null, layer: null, main: null, bubble: null, text: null, action: null, home: null,
    x: 0, y: 0, rot: 0, key: null, keyX1: 0, facing: '', gaze: '', act: '',
    perches: [], view: null, width: 0,
    tasks: [], cur: null, pending: null, raf: 0, taskTimer: 0, idleTimer: 0,
    bubbleTimer: 0, relayoutTimer: 0, scrollTimer: 0,
    lastIdle: '', lastInteraction: 0, napping: false, nudge: false, celebrateUntil: 0,
    hover: false, focus: false, bubbleShown: false, bubbleUntil: 0, bubbleW: 160, bubbleH: 40,
    side: '', vert: '', lastText: '',
    press: null, drag: null, suppressClick: false, settles: 0, puffs: 0, lastPuff: 0,
    cleanups: [], mq: null
  };

  const $ = id => document.getElementById(id);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function api() {
    return typeof LitPopup !== 'undefined' ? LitPopup.api : null;
  }

  function roamPref() {
    return typeof LitPopup === 'undefined' || LitPopup.modulePref('buddyRoam', true) !== false;
  }

  function wanted() {
    const a = api();
    if (!a || !$('buddy') || !$('buddy-layer') || !$('buddy-btn')) return false;
    if (!roamPref()) return false;
    if (a.reduceMotion) return false;
    if (S.mq && S.mq.matches) return false;
    if (document.documentElement.dataset.motion === 'reduce') return false;
    if ((a.prefs || {}).buddyEnabled === false) return false;
    return typeof LitBuddy !== 'undefined';
  }

  function sync() {
    const w = wanted();
    if (w && !S.on) start();
    else if (!w && S.on) stop();
  }

  // ----- Drawing -------------------------------------------------------------
  function svgEl() {
    return S.btn ? S.btn.querySelector('.buddy-svg') : null;
  }

  function orient() {
    const svg = svgEl();
    if (!svg) return;
    const parts = [];
    if (S.rot) parts.push('rotate(' + S.rot.toFixed(1) + 'deg)');
    if (S.facing === 'left') parts.push('scaleX(-1)');
    svg.style.transform = parts.join(' ');
  }

  function place() {
    S.box.style.transform = 'translate3d(' + (S.x - HALF).toFixed(1) + 'px,' + (S.y - SIZE.foot).toFixed(1) + 'px,0)';
    if (S.bubbleShown) placeBubble();
  }

  function setAction(a) {
    if (S.act === a) return;
    S.act = a;
    S.box.dataset.action = a;
  }

  function setGaze(g) {
    if (S.gaze === g) return;
    S.gaze = g;
    S.box.dataset.gaze = g;
  }

  function setFacing(f) {
    if (S.facing === f) return;
    S.facing = f;
    S.box.dataset.facing = f;
    orient();
  }

  function setRot(r) {
    const v = Math.abs(r) < 0.05 ? 0 : r;
    if (v === S.rot) return;
    S.rot = v;
    orient();
  }

  function perchByKey(key) {
    if (key == null) return null;
    return S.perches.find(p => p.key === key) || null;
  }

  function setKey(key) {
    S.key = key;
    const p = perchByKey(key);
    S.keyX1 = p ? p.x1 : 0;
  }

  function dust(dir) {
    const t = now();
    if (t - S.lastPuff < 110 || S.puffs >= 6) return;
    S.lastPuff = t;
    const d = document.createElement('span');
    d.className = 'buddy-dust';
    d.setAttribute('aria-hidden', 'true');
    d.style.transform = 'translate3d(' + (S.x - dir * 11).toFixed(1) + 'px,' + (S.y - 3).toFixed(1) + 'px,0)';
    d.style.setProperty('--drift', (-dir * 9) + 'px');
    S.layer.appendChild(d);
    S.puffs += 1;
    let gone = false;
    const done = () => {
      if (gone) return;
      gone = true;
      d.remove();
      S.puffs = Math.max(0, S.puffs - 1);
    };
    d.addEventListener('animationend', done, { once: true });
    setTimeout(done, 900);
  }

  // ----- Layout --------------------------------------------------------------
  function shownRect(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  }

  function local(r, lr) {
    return { left: r.left - lr.left, top: r.top - lr.top, right: r.right - lr.left, bottom: r.bottom - lr.top };
  }

  function measureView() {
    const lr = S.layer.getBoundingClientRect();
    const bar = document.querySelector('.topbar');
    const barBottom = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    S.width = lr.width;
    S.view = { top: Math.max(0, barBottom - lr.top), bottom: Math.min(lr.height, vh - lr.top), left: 0, right: lr.width };
    return lr;
  }

  function measure() {
    const lr = measureView();
    const view = S.view;
    const items = [];
    const add = (key, kind, el) => {
      const r = shownRect(el);
      if (r) items.push({ key, kind, rect: local(r, lr) });
    };
    add('counter', 'counter', $('counter-card'));
    // The seat: inside the counter card, beside the ring, where it used to sit.
    const side = shownRect(document.querySelector('#counter-card .counter-side'));
    const main = shownRect(document.querySelector('#counter-card .counter-main'));
    if (side && main) {
      items.push({ key: 'seat', kind: 'seat', rect: local({ left: side.left, right: side.right, top: main.bottom - 1, bottom: main.bottom }, lr) });
    }
    add('tabs', 'tabs', document.querySelector('#main-view .tracker-tabs'));
    const stories = $('stories-host');
    if (stories) Array.prototype.forEach.call(stories.children, (c, i) => add('stories:' + i, 'stories', c));
    NOTE_CARDS.forEach(id => add(id, 'note', $(id)));
    const host = $('widgets-host');
    if (host) {
      Array.prototype.forEach.call(host.children, (w, i) => {
        if (w.classList && w.classList.contains('widget')) add('w:' + (w.dataset.widgetId || i), 'card', w);
      });
    }
    const mini = $('miniplayer-host');
    if (mini) Array.prototype.forEach.call(mini.children, (c, i) => add('mini:' + i, 'mini', c));
    add('footer', 'footer', document.querySelector('#main-view > .footer'));
    if (view.bottom - view.top > SIZE.h + 8) {
      items.push({ key: 'floor', kind: 'floor', rect: { left: 8, right: lr.width - 8, top: view.bottom - 2, bottom: view.bottom } });
    }
    const obstacles = [];
    S.main.querySelectorAll(CONTROLS).forEach(n => {
      if (S.box.contains(n)) return;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const l = local(r, lr);
      if (l.bottom < view.top - 60 || l.top > view.bottom + 60) return;
      obstacles.push(l);
    });
    // Never sit on the counter's own words (label, going-for, week line).
    document.querySelectorAll('#counter-card .counter-side > *').forEach(n => {
      if (n === S.box) return;
      const r = shownRect(n);
      if (r) obstacles.push(local(r, lr));
    });
    S.perches = buildPerches(items, obstacles, SIZE);
    return S.perches;
  }

  function usable() {
    return S.perches.filter(p => inView(p, S.view));
  }

  function onScreen() {
    return !!S.view && S.y - SIZE.foot >= S.view.top - 4 && S.y <= S.view.bottom + 4;
  }

  function ringInfo() {
    const r = shownRect($('ring-wrap'));
    if (!r) return null;
    const lr = S.layer.getBoundingClientRect();
    const l = local(r, lr);
    // The ring's outer edge: radius 52 plus half the 8 wide stroke, of 120.
    const rad = (l.right - l.left) * 56 / 120;
    return { cx: (l.left + l.right) / 2, cy: (l.top + l.bottom) / 2, r: rad };
  }

  // A spot on the counter card near `want`: on its top edge or on the seat
  // beside the ring (`prefer` picks which to try first). Prefers a free spot
  // within maxShift; otherwise stands at `want` for a moment (settle moves it
  // off any control after).
  function counterSpot(want, maxShift, prefer) {
    const keys = prefer === 'seat' ? ['seat', 'counter'] : ['counter', 'seat'];
    const shown = keys.map(perchByKey).filter(p => p && inView(p, S.view));
    for (let i = 0; i < shown.length; i++) {
      const free = bestX(shown[i], want);
      if (free !== null && Math.abs(free - want) <= maxShift) return { key: shown[i].key, x: free };
    }
    return shown.length ? { key: shown[0].key, x: clamp(want, shown[0].lo, shown[0].hi) } : null;
  }

  function onCounter() {
    return S.key === 'counter' || S.key === 'seat';
  }

  // ----- Tasks ---------------------------------------------------------------
  // A task: { act, gaze, dur (ms; Infinity holds), hold, airborne,
  //           start(task), step(elapsedMs, dt, task) -> done }
  function go(list) {
    (list || []).forEach(t => { if (t) S.tasks.push(t); });
    if (!S.cur) runNext();
  }

  function clearTasks() {
    S.tasks = [];
    S.cur = null;
    S.pending = null;
    clearTimeout(S.taskTimer);
    S.taskTimer = 0;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
  }

  function runNext() {
    clearTimeout(S.taskTimer);
    S.taskTimer = 0;
    S.cur = null;
    if (!S.on || S.blocked) return;
    if (S.pending) {
      const plan = S.pending;
      S.pending = null;
      S.tasks = [];
      plan();
      if (!S.cur) settle();
      return;
    }
    const t = S.tasks.shift();
    if (!t) { settle(); return; }
    S.cur = t;
    t.t0 = now();
    t.last = t.t0;
    if (t.act) setAction(t.act);
    setGaze(t.gaze || 'front');
    if (t.start) t.start(t);
    if (S.cur !== t) return;
    if (t.step) loop();
    else if (Number.isFinite(t.dur)) S.taskTimer = setTimeout(runNext, t.dur);
  }

  function loop() {
    if (!S.raf && !S.blocked && S.on) S.raf = requestAnimationFrame(frame);
  }

  function frame() {
    S.raf = 0;
    const t = S.cur;
    if (!t || !t.step || S.blocked || !S.on) return;
    const n = now();
    const dt = Math.min(0.05, Math.max(0, (n - t.last) / 1000));
    t.last = n;
    let done = true;
    try {
      done = t.step(n - t.t0, dt, t);
    } catch (e) {
      console.warn('[LIT] buddy-roam step', e);
    }
    place();
    if (done) runNext();
    else loop();
  }

  function pose(act, dur, extra) {
    return Object.assign({ act, dur, gaze: 'front' }, extra || {});
  }

  function hold(act) {
    return { act, dur: Infinity, hold: true, gaze: 'front' };
  }

  function walkTask(leg, pace) {
    const run = pace === 'run';
    const speed = run ? PACE.run : PACE.walk;
    const dx = leg.x1 - leg.x0;
    const dur = Math.max(140, Math.abs(dx) / speed * 1000);
    return {
      act: run ? 'run' : 'walk',
      gaze: 'side',
      start() {
        setFacing(facingFor(dx, S.facing));
        setRot(0);
        setKey(leg.key);
      },
      step(el) {
        const u = clamp(el / dur, 0, 1);
        const p = perchByKey(leg.key);
        if (!p) return true;
        S.x = clamp(leg.x0 + dx * u, p.lo, p.hi);
        S.y = p.y;
        if (run) dust(dx >= 0 ? 1 : -1);
        return u >= 1;
      }
    };
  }

  // A hop: crouch, fly a ballistic arc, land with a squash. leg.x1 / leg.key
  // left null mean "straight up and back down where it is".
  function hopTasks(leg, opts) {
    const o = opts || {};
    const air = {
      act: o.spin ? 'tumble' : 'hop',
      gaze: o.spin ? 'front' : 'side',
      airborne: true,
      start(t) {
        t.x0 = S.x;
        t.y0 = S.y;
        t.key = leg.key === undefined || leg.key === null ? (leg.y1 == null ? S.key : null) : leg.key;
        t.x1 = leg.x1 == null ? S.x : leg.x1;
        const p = perchByKey(t.key);
        t.y1 = p ? p.y : (leg.y1 == null ? S.y : leg.y1);
        const lift = o.lift != null ? o.lift : hopLift(t.x0, t.y0, t.x1, t.y1);
        t.k = arcK(t.y0, t.y1, lift);
        t.d = (o.dur || hopDuration(t.k)) * 1000;
        if (Math.abs(t.x1 - t.x0) > 2) setFacing(facingFor(t.x1 - t.x0, S.facing));
        S.key = null;
      },
      step(el, dt, t) {
        const p = perchByKey(t.key);
        const y1 = p ? p.y : t.y1;
        const u = clamp(el / t.d, 0, 1);
        const pt = arcPoint(t.x0, t.y0, t.x1, y1, t.k, u);
        S.x = pt.x;
        S.y = pt.y;
        if (o.spin) setRot((o.spin * easeInOut(u)) % 360);
        if (u >= 1) {
          setRot(0);
          if (p) { S.x = clamp(S.x, p.lo, p.hi); setKey(p.key); }
          return true;
        }
        return false;
      }
    };
    return [pose('crouch', o.quick ? 60 : 90), air, pose('land', 150)];
  }

  // Falling (dropped) or tumbling (flung) until it lands on an edge, or on
  // the bottom of the visible board.
  function fallTask(vx, vy, spin) {
    return {
      act: spin ? 'tumble' : 'hop',
      gaze: 'front',
      airborne: true,
      start(t) {
        S.key = null;
        t.b = { x: S.x, y: S.y, vx: vx || 0, vy: vy || 0, rot: S.rot, spin: spin || 0 };
      },
      step(el, dt, t) {
        const v = S.view;
        const bounds = { left: HALF + 2, right: S.width - HALF - 2, top: v.top + SIZE.foot };
        const prevY = t.b.y;
        const b = stepBody(t.b, dt, bounds);
        t.b = b;
        S.x = b.x;
        S.y = b.y;
        if (spin) setRot(b.rot % 360);
        const hit = landingFor(usable(), b.x, prevY, b.y);
        if (hit) {
          S.x = clamp(b.x, hit.lo, hit.hi);
          S.y = hit.y;
          setKey(hit.key);
          setRot(0);
          return true;
        }
        if (b.y >= v.bottom - 1 || el > 4000) {
          S.y = Math.min(b.y, v.bottom - 1);
          setKey(perchByKey('floor') ? 'floor' : null);
          setRot(0);
          return true;
        }
        return false;
      }
    };
  }

  function orbitTask(cx, cy, r, ms) {
    return {
      act: 'run',
      gaze: 'side',
      airborne: true,
      start() {
        setFacing('right');
        S.key = null;
      },
      step(el) {
        const u = clamp(el / ms, 0, 1);
        const pt = orbitPoint(cx, cy, r, 360 * easeInOut(u));
        S.x = pt.x;
        S.y = pt.y;
        setRot(u >= 1 ? 0 : pt.rot);
        return u >= 1;
      }
    };
  }

  function routeTasks(target, pace) {
    const list = S.perches.filter(p => inView(p, S.view) || p.key === S.key);
    const legs = planRoute(list, { x: S.x, y: S.y, key: S.key }, target);
    const out = [];
    legs.forEach(leg => {
      if (leg.type === 'walk') out.push(walkTask(leg, pace));
      else out.push.apply(out, hopTasks(leg, { quick: pace === 'run' }));
    });
    return out;
  }

  // ----- Behaviour -----------------------------------------------------------
  // The queue ran dry: make sure it is standing somewhere visible and out of
  // the way, then hold a nudge, keep napping, or wait for the next idle beat.
  function settle() {
    if (!S.on || S.blocked || S.drag) return;
    clearTimeout(S.idleTimer);
    S.idleTimer = 0;
    if (!S.view) measure();
    const p = perchByKey(S.key);
    if (!p || Math.abs(p.y - S.y) > 1.5) {
      if (p && Math.abs(p.y - S.y) <= 40) {
        S.y = p.y;
        place();
      } else if (S.settles++ < 4) {
        S.key = null;
        go([fallTask(0, 0, 0), pose('land', 150)]);
        return;
      }
    }
    if (!onScreen() && S.settles++ < 4) { relocate(); return; }
    const spot = settleSpot(usable(), { x: S.x, y: S.y, key: S.key });
    if (spot && S.settles++ < 4) { go(routeTasks(spot, 'walk')); return; }
    if (S.nudge) {
      const c = counterSpot(S.width / 2, Infinity);
      if (c && !onCounter() && S.settles++ < 4) { go(routeTasks(c, 'walk')); return; }
      S.settles = 0;
      go([hold('wave')]);
      return;
    }
    S.settles = 0;
    setRot(0);
    setGaze('front');
    if (S.napping) { go([hold('nap')]); return; }
    setAction('stand');
    scheduleIdle();
  }

  // Off screen after a scroll: drop in from the top of what is visible.
  function relocate() {
    measure();
    S.key = null;
    S.x = clamp(S.x, HALF + 4, S.width - HALF - 4);
    S.y = S.view.top + SIZE.foot + 2;
    setRot(0);
    place();
    go([fallTask(0, 80, 0), pose('land', 160)]);
  }

  function scheduleIdle() {
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(idleTick, idleDelay({ now: now(), lastInteraction: S.lastInteraction }));
  }

  function idleTick() {
    S.idleTimer = 0;
    if (!S.on || S.blocked || S.drag || S.cur) return;
    measure();
    let kind = idleDecision({ now: now(), lastInteraction: S.lastInteraction, last: S.lastIdle, nudge: S.nudge });
    S.lastIdle = kind;
    if (kind === 'nap') {
      S.napping = true;
      go([pose('sit', 500), pose('yawn', 1700), hold('nap')]);
      return;
    }
    if (kind === 'wander') {
      const spot = pickWander(usable(), { x: S.x, y: S.y, key: S.key });
      const p = spot && perchByKey(spot.key);
      if (spot && p) {
        const far = Math.abs(spot.x - S.x) + Math.abs(p.y - S.y) > 170;
        go(routeTasks(spot, far || Math.random() < 0.2 ? 'run' : 'walk'));
        return;
      }
      kind = 'look';
    }
    if (kind === 'look') go(lookTasks());
    else if (kind === 'sit') go([pose('sit', 3200 + Math.random() * 2200)]);
    else go([pose('wave', 1800)]);
  }

  function lookTasks() {
    const first = Math.random() < 0.5 ? 'left' : 'right';
    const second = first === 'left' ? 'right' : 'left';
    return [
      pose('look', 800, { gaze: 'side', start() { setFacing(first); } }),
      pose('look', 800, { gaze: 'side', start() { setFacing(second); } }),
      pose('look', 400, { gaze: 'front' })
    ];
  }

  // Something happened: drop what it is doing (finishing a hop in the air
  // first) and react.
  function interrupt(plan) {
    if (!S.on || S.blocked || S.drag) return;
    clearTimeout(S.idleTimer);
    S.idleTimer = 0;
    S.napping = false;
    if (S.cur && S.cur.airborne) { S.pending = plan; return; }
    clearTasks();
    S.settles = 0;
    plan();
    if (!S.cur) settle();
  }

  function cheerHops() {
    return hopTasks({ x1: null, key: null }, { lift: 16, quick: true })
      .concat(hopTasks({ x1: null, key: null }, { lift: 11, quick: true }))
      .concat([pose('cheer', 1200)]);
  }

  function onLog() {
    // A goal-met lap may already be running: that is the bigger party.
    if (now() < S.celebrateUntil) return;
    interrupt(() => {
      measure();
      const ring = ringInfo();
      // Next to the ring: the seat beside it, or the edge above it.
      const spot = counterSpot(ring ? ring.cx + ring.r + 40 : S.x, 90, 'seat');
      go((spot ? routeTasks(spot, 'run') : []).concat(cheerHops()));
    });
  }

  function onGoalMet() {
    S.celebrateUntil = now() + 6000;
    interrupt(() => {
      measure();
      const ring = ringInfo();
      const top = perchByKey('counter');
      const spot = ring && top && inView(top, S.view) ? { key: 'counter', x: clamp(ring.cx, top.lo, top.hi) } : null;
      const v = S.view;
      const ringVisible = ring && ring.cy - ring.r - 6 >= v.top && ring.cy + ring.r + 6 <= v.bottom;
      if (!spot || !ringVisible) { go(cheerHops()); return; }
      go(routeTasks(spot, 'run')
        .concat(hopTasks({ x1: ring.cx, y1: ring.cy - ring.r, key: null }, { lift: 8, quick: true }))
        .concat([orbitTask(ring.cx, ring.cy, ring.r, 1500)])
        .concat(hopTasks({ x1: spot.x, key: 'counter' }, { lift: 30, spin: 360 }))
        .concat([pose('cheer', 1400)]));
    });
  }

  function onUndo() {
    interrupt(() => go([pose('shrug', 1100)]));
  }

  function onTab(d) {
    interrupt(() => {
      measure();
      const id = d && d.metric && d.metric.id;
      const tabs = $('metric-tabs');
      let tab = null;
      if (id && tabs) tab = Array.prototype.find.call(tabs.querySelectorAll('.tab-item'), n => n.dataset.metricId === id) || null;
      const p = perchByKey('tabs');
      const r = shownRect(tab);
      if (!p || !r || !inView(p, S.view)) { go(lookTasks()); return; }
      const lr = S.layer.getBoundingClientRect();
      const cx = (r.left + r.right) / 2 - lr.left;
      // Stop just short of the tab so the lean puts the face over it.
      const dir = cx >= S.x ? 1 : -1;
      const x = clamp(cx - dir * 8, p.lo, p.hi);
      go(routeTasks({ key: 'tabs', x }, 'run').concat([
        pose('peek', 1500, { gaze: 'down', start() { setFacing(dir > 0 ? 'right' : 'left'); } })
      ]));
    });
  }

  function nudgeChanged() {
    const showing = !!(S.action && !S.action.classList.contains('hidden'));
    if (showing === S.nudge) return;
    S.nudge = showing;
    updateBubble();
    if (showing) {
      interrupt(() => {
        measure();
        const c = counterSpot(S.width / 2, Infinity);
        go((c ? routeTasks(c, 'walk') : []).concat([hold('wave')]));
      });
    } else if (S.on && !S.blocked && S.cur && S.cur.hold) {
      clearTasks();
      go([pose('stretch', 600)]);
    }
  }

  function interaction() {
    S.lastInteraction = now();
    if (S.napping && S.on && !S.blocked && !S.drag) {
      S.napping = false;
      if (S.cur && S.cur.airborne) return;
      clearTasks();
      go([pose('stretch', 700)]);
    }
  }

  // Keyboard: arrows walk to the previous or next edge.
  function onKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!S.on || S.blocked || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    interrupt(() => {
      measure();
      const next = neighborPerch(usable(), S.key, S.x, S.y, dir);
      if (!next) { go([pose('shrug', 700)]); return; }
      go(routeTasks({ key: next.key, x: bestX(next, S.x) }, 'walk'));
    });
  }

  // ----- Picking it up -------------------------------------------------------
  function onPointerDown(e) {
    if (!S.on || S.blocked || (e.button !== undefined && e.button > 0)) return;
    S.press = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: S.x, oy: S.y, samples: [{ x: e.clientX, y: e.clientY, t: now() }] };
  }

  function onPointerMove(e) {
    const pr = S.press;
    if (!pr || e.pointerId !== pr.id) return;
    const dx = e.clientX - pr.sx;
    const dy = e.clientY - pr.sy;
    if (!S.drag) {
      if (dx * dx + dy * dy < 36) return;
      S.drag = pr;
      clearTasks();
      clearTimeout(S.idleTimer);
      S.napping = false;
      try { S.btn.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
      measure();
      S.box.dataset.dragging = 'true';
      S.key = null;
      setRot(0);
      setAction('dangle');
      setGaze('front');
    }
    const v = S.view;
    const last = pr.samples[pr.samples.length - 1];
    S.x = clamp(pr.ox + dx, HALF + 2, S.width - HALF - 2);
    S.y = clamp(pr.oy + dy, v.top + SIZE.foot, v.bottom);
    setFacing(facingFor(e.clientX - last.x, S.facing));
    const t = now();
    pr.samples.push({ x: e.clientX, y: e.clientY, t });
    while (pr.samples.length > 2 && t - pr.samples[0].t > 160) pr.samples.shift();
    place();
    e.preventDefault();
  }

  function onPointerUp(e) {
    const pr = S.press;
    if (!pr || e.pointerId !== pr.id) return;
    S.press = null;
    if (!S.drag) return;
    S.drag = null;
    delete S.box.dataset.dragging;
    S.suppressClick = true;
    setTimeout(() => { S.suppressClick = false; }, 400);
    try { S.btn.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    S.lastInteraction = now();
    if (!S.on || S.blocked) return;
    measure();
    const vel = e.type === 'pointercancel' ? { x: 0, y: 0 } : flingVelocity(pr.samples, now());
    const speed = Math.hypot(vel.x, vel.y);
    // Let go with the feet just past an edge: step onto it.
    const snap = landingFor(usable(), S.x, S.y - 14, S.y + 2);
    if (speed < FLING_SPEED && snap) {
      S.x = clamp(S.x, snap.lo, snap.hi);
      S.y = snap.y;
      setKey(snap.key);
      place();
      go([pose('land', 160)]);
      return;
    }
    if (speed >= FLING_SPEED) {
      const vx = clamp(vel.x, -1400, 1400);
      const vy = clamp(vel.y, -1400, 1400);
      const spin = clamp(vx * 1.1, -900, 900) || 540;
      go([fallTask(vx, vy, spin), pose('land', 170), pose('dizzy', 900)]);
      return;
    }
    go([fallTask(0, 0, 0), pose('land', 160)]);
  }

  function onClickCapture(e) {
    if (!S.suppressClick || !S.btn.contains(e.target)) return;
    S.suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // ----- Speech bubble -------------------------------------------------------
  function hasWords() {
    return !!(S.text && S.text.textContent.trim());
  }

  function updateBubble() {
    if (!S.on) return;
    const t = now();
    const want = !S.drag && (S.nudge || ((S.hover || S.focus || t < S.bubbleUntil) && hasWords()));
    if (want !== S.bubbleShown) {
      S.bubbleShown = want;
      if (want) {
        measureBubble();
        placeBubble();
      }
      S.box.dataset.bubble = want ? 'show' : 'hide';
    }
    clearTimeout(S.bubbleTimer);
    S.bubbleTimer = 0;
    if (want && !S.nudge && !S.hover && !S.focus) S.bubbleTimer = setTimeout(updateBubble, Math.max(50, S.bubbleUntil - t + 20));
  }

  function flashBubble(ms) {
    S.bubbleUntil = Math.max(S.bubbleUntil, now() + ms);
    updateBubble();
  }

  function placeBubble() {
    if (!S.view) return;
    const pl = bubblePlacement({ x: S.x, y: S.y, width: S.width, top: S.view.top, bubbleW: S.bubbleW, bubbleH: S.bubbleH, prev: S.side, avoid: protectedText(), measureAt: bubbleHeightAt });
    if (pl.side !== S.side) { S.side = pl.side; S.box.dataset.bubbleSide = pl.side; }
    if (pl.vert !== S.vert) { S.vert = pl.vert; S.box.dataset.bubbleVert = pl.vert; }
    if (pl.maxWidth) S.box.style.setProperty('--bubble-beside-w', pl.maxWidth + 'px');
    else S.box.style.removeProperty('--bubble-beside-w');
  }

  // Words and main controls the speech bubble steps around, in layer
  // coordinates: the counter's label and buttons, the headline, the week line.
  const PROTECTED_TEXT = ['#metric-unit-label', '#going-for', '#week-line', '#day-headline', '#action-buttons', '#metric-tabs', '#ring-wrap'];
  const PROTECTED_WEIGHT = { '#action-buttons': 4, '#metric-tabs': 2, '#ring-wrap': 2 };
  function protectedText() {
    if (!S.layer) return [];
    const lr = S.layer.getBoundingClientRect();
    const out = [];
    PROTECTED_TEXT.forEach(sel => {
      const r = shownRect(document.querySelector(sel));
      if (r) out.push({ left: r.left - lr.left, right: r.right - lr.left, top: r.top - lr.top, bottom: r.bottom - lr.top, weight: PROTECTED_WEIGHT[sel] || 1 });
    });
    return out;
  }

  // The bubble's height when wrapped to `w` px (for the 'beside' spot),
  // measured on the live bubble and put back the way it was.
  function bubbleHeightAt(w) {
    const st = S.bubble.style;
    const before = st.maxWidth;
    st.maxWidth = Math.round(w) + 'px';
    const h = S.bubble.offsetHeight;
    st.maxWidth = before;
    return h;
  }

  // The bubble's natural size: measured in its usual above/below layout, so
  // a narrowed 'beside' wrap never feeds back into the next placement.
  function measureBubble() {
    const vert = S.box.dataset.bubbleVert;
    const beside = vert === 'beside';
    if (beside) S.box.dataset.bubbleVert = 'above';
    const w = S.bubble.offsetWidth;
    const h = S.bubble.offsetHeight;
    if (beside) S.box.dataset.bubbleVert = vert;
    S.bubbleW = w || S.bubbleW;
    S.bubbleH = h || S.bubbleH;
  }

  function textChanged() {
    const t = S.text.textContent;
    if (t === S.lastText) return;
    S.lastText = t;
    measureBubble();
    if (S.bubbleShown) placeBubble();
    flashBubble(BUBBLE_MS);
  }

  // ----- Pausing -------------------------------------------------------------
  function customizing() {
    const host = $('widgets-host');
    return !!(host && host.classList.contains('customizing'));
  }

  function overlayOpen() {
    const o = $('overlay-host');
    return !!(o && o.childElementCount > 0);
  }

  function isBlocked() {
    const a = api();
    return !!(document.hidden || (a && a.openModalId) || customizing() || overlayOpen() ||
      (S.main && S.main.classList.contains('hidden')));
  }

  function refreshBlocked() {
    if (!S.on) return;
    const away = customizing() || overlayOpen();
    if (away) S.box.setAttribute('data-away', '');
    else S.box.removeAttribute('data-away');
    const b = isBlocked();
    if (b === S.blocked) return;
    S.blocked = b;
    if (b) freeze();
    else resume();
  }

  function freeze() {
    clearTasks();
    clearTimeout(S.idleTimer);
    clearTimeout(S.scrollTimer);
    clearTimeout(S.relayoutTimer);
    S.idleTimer = 0;
    if (S.drag || S.press) {
      S.drag = null;
      S.press = null;
      delete S.box.dataset.dragging;
    }
    setRot(0);
    setAction(S.napping ? 'nap' : 'stand');
  }

  function resume() {
    S.lastInteraction = now();
    S.napping = false;
    measure();
    S.settles = 0;
    if (S.needsEntrance) { S.needsEntrance = false; entrance(); return; }
    settle();
  }

  // Layout changed (cards re-rendered or resized): move with the edge it is
  // standing on, or fall if the edge went away. Moving tasks read edges live.
  function scheduleRelayout() {
    clearTimeout(S.relayoutTimer);
    S.relayoutTimer = setTimeout(relayout, 60);
  }

  function relayout() {
    S.relayoutTimer = 0;
    if (!S.on || S.blocked) return;
    measure();
    if (S.drag || (S.cur && !S.cur.hold)) return;
    const p = perchByKey(S.key);
    if (p) {
      S.x = clamp(S.x + (p.x1 - S.keyX1), p.lo, p.hi);
      S.keyX1 = p.x1;
      S.y = p.y;
      place();
      if (isFree(p, S.x) && onScreen()) return;
    }
    if (S.cur && S.cur.hold && S.cur.act === 'nap' && p && onScreen()) return;
    clearTasks();
    settle();
  }

  function onScroll() {
    interaction();
    clearTimeout(S.scrollTimer);
    S.scrollTimer = setTimeout(() => {
      S.scrollTimer = 0;
      if (!S.on || S.blocked || S.drag) return;
      measureView();
      if (S.bubbleShown) placeBubble();
      if (S.cur && !S.cur.hold) return;
      if (!onScreen()) {
        clearTasks();
        clearTimeout(S.idleTimer);
        relocate();
      }
    }, 180);
  }

  // ----- Start and stop ------------------------------------------------------
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    S.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function observe(target, options, fn) {
    if (!target || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(fn);
    mo.observe(target, options);
    S.cleanups.push(() => mo.disconnect());
  }

  function entrance() {
    measure();
    if (S.goalPending && now() - S.goalPending < 8000) {
      S.goalPending = 0;
      onGoalMet();
      if (S.cur) return;
    }
    const ring = ringInfo();
    const spot = counterSpot(ring ? ring.cx + ring.r + 40 : S.x, 140);
    if (spot) go(routeTasks(spot, 'walk'));
    else settle();
  }

  function start() {
    S.box = $('buddy');
    S.btn = $('buddy-btn');
    S.layer = $('buddy-layer');
    S.main = $('main-view');
    S.bubble = $('buddy-bubble');
    S.text = $('buddy-text');
    S.action = $('buddy-action');
    if (!S.box || !S.btn || !S.layer || !S.main || !S.bubble || !S.text) return;
    S.home = { parent: S.box.parentNode, next: S.box.nextSibling };

    // Start exactly where it sat, then hop up onto the board.
    const lr = S.layer.getBoundingClientRect();
    const seat = shownRect(S.btn);
    S.layer.appendChild(S.box);
    S.box.classList.add('roam');
    S.on = true;
    S.x = seat ? (seat.left + seat.right) / 2 - lr.left : lr.width / 2;
    S.y = seat ? seat.top + seat.height * (42 / 44) - lr.top : SIZE.foot;
    S.key = null;
    S.rot = 0;
    S.facing = '';
    S.gaze = '';
    S.act = '';
    S.side = '';
    S.vert = '';
    S.napping = false;
    S.settles = 0;
    S.lastInteraction = now();
    S.lastText = S.text.textContent;
    setFacing('right');
    setGaze('front');
    setAction('stand');
    S.box.dataset.bubble = 'hide';
    S.bubbleShown = false;
    S.nudge = !!(S.action && !S.action.classList.contains('hidden'));
    measureView();
    place();

    listen(S.btn, 'pointerdown', onPointerDown);
    listen(window, 'pointermove', onPointerMove, { passive: false });
    listen(window, 'pointerup', onPointerUp);
    listen(window, 'pointercancel', onPointerUp);
    listen(S.box, 'click', onClickCapture, true);
    listen(S.btn, 'keydown', onKey);
    listen(S.box, 'pointerenter', () => { S.hover = true; updateBubble(); });
    listen(S.box, 'pointerleave', () => { S.hover = false; S.bubbleUntil = Math.max(S.bubbleUntil, now() + 1200); updateBubble(); });
    listen(S.box, 'focusin', () => { S.focus = true; updateBubble(); });
    listen(S.box, 'focusout', () => { S.focus = false; S.bubbleUntil = Math.max(S.bubbleUntil, now() + 1200); updateBubble(); });
    listen(document, 'pointerdown', interaction, { passive: true, capture: true });
    listen(document, 'keydown', interaction, { passive: true, capture: true });
    listen(document, 'wheel', interaction, { passive: true });
    listen(document, 'pointermove', () => { if (now() - S.lastInteraction > 400) interaction(); }, { passive: true });
    listen(window, 'scroll', onScroll, { passive: true });
    listen(window, 'resize', scheduleRelayout);
    listen(document, 'visibilitychange', refreshBlocked);
    observe(S.text, { childList: true, characterData: true, subtree: true }, textChanged);
    if (S.action) observe(S.action, { attributes: true, attributeFilter: ['class'] }, nudgeChanged);
    observe($('widgets-host'), { attributes: true, attributeFilter: ['class'] }, refreshBlocked);
    observe(S.main, { attributes: true, attributeFilter: ['class'] }, refreshBlocked);
    observe($('overlay-host'), { childList: true }, refreshBlocked);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(scheduleRelayout);
      ro.observe(S.main);
      S.cleanups.push(() => ro.disconnect());
    }

    S.blocked = isBlocked();
    if (customizing() || overlayOpen()) S.box.setAttribute('data-away', '');
    flashBubble(3500);
    if (S.blocked) { S.needsEntrance = true; return; }
    entrance();
  }

  function stop() {
    S.on = false;
    clearTasks();
    [S.idleTimer, S.bubbleTimer, S.scrollTimer, S.relayoutTimer].forEach(t => clearTimeout(t));
    S.idleTimer = S.bubbleTimer = S.scrollTimer = S.relayoutTimer = 0;
    S.cleanups.splice(0).forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    if (S.layer) S.layer.querySelectorAll('.buddy-dust').forEach(n => n.remove());
    S.puffs = 0;
    S.drag = null;
    S.press = null;
    S.napping = false;
    S.nudge = false;
    S.blocked = false;
    S.needsEntrance = false;
    S.hover = false;
    S.focus = false;
    S.bubbleShown = false;
    const b = S.box;
    if (!b) return;
    b.classList.remove('roam');
    ['action', 'gaze', 'facing', 'bubble', 'bubbleSide', 'bubbleVert', 'dragging'].forEach(k => { delete b.dataset[k]; });
    b.removeAttribute('data-away');
    b.style.transform = '';
    const svg = svgEl();
    if (svg) svg.style.transform = '';
    const h = S.home;
    if (h && h.parent && h.parent.isConnected) {
      h.parent.insertBefore(b, h.next && h.next.parentNode === h.parent ? h.next : null);
    }
  }

  function init() {
    if (S.inited || typeof LitPopup === 'undefined') return;
    S.inited = true;
    LitPopup.on('render', () => {
      sync();
      if (!S.on) return;
      refreshBlocked();
      scheduleRelayout();
    });
    LitPopup.on('log', () => { if (S.on) onLog(); });
    LitPopup.on('undo', () => { if (S.on) onUndo(); });
    LitPopup.on('tab', d => { if (S.on) onTab(d); });
    // popup.js clears its open dialog right after this event; check after.
    LitPopup.on('modal', () => setTimeout(() => { if (S.on) refreshBlocked(); }, 0));
    try {
      S.mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (S.mq && S.mq.addEventListener) S.mq.addEventListener('change', sync);
    } catch (e) {
      S.mq = null;
    }
    sync();
  }

  if (typeof LitPopup !== 'undefined' && typeof document !== 'undefined') {
    LitPopup.addSetting({
      id: 'buddy-roam',
      label: 'Buddy roams the board',
      hint: 'Walks, runs, and naps around your cards',
      get: () => roamPref(),
      set: async next => {
        await LitPopup.setModulePref('buddyRoam', !!next);
        sync();
      }
    });
    // The goal can be met during the very first render (an application
    // logged while the popup was shut); remember it for the entrance.
    LitPopup.on('goal-met', () => {
      if (S.on) onGoalMet();
      else S.goalPending = now();
    });
    LitPopup.whenReady(init);
  }

  return {
    SIZE,
    PACE,
    GRAVITY,
    NAP_AFTER,
    ACTIONS,
    clamp,
    mergeIntervals,
    freeIntervals,
    blockedFor,
    buildPerches,
    isFree,
    bestX,
    inView,
    perchOrder,
    neighborPerch,
    planRoute,
    arcK,
    arcPoint,
    hopDuration,
    hopLift,
    facingFor,
    bubblePlacement,
    idleDecision,
    idleDelay,
    pickWander,
    settleSpot,
    stepBody,
    landingFor,
    orbitPoint,
    flingVelocity,
    easeInOut
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BuddyRoam;
