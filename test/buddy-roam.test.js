// Tests for popup/modules/buddy-roam.js: the pure parts that decide where the
// roaming buddy goes (edges from rectangles, routes, hop arcs, facing, bubble
// side, idle choices, falling), plus the character rig in shared/buddy.js and
// the poses the CSS has to cover.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function fresh(rel) {
  const file = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

// A seeded random source so choices are repeatable.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ' expected ' + b + ', got ' + a);

async function run() {
  console.log('--- Running test/buddy-roam.test.js ---');

  // Loads in node without a DOM and without the bridge.
  const hadDoc = typeof global.document !== 'undefined';
  const R = fresh('popup/modules/buddy-roam.js');
  assert.strictEqual(typeof global.document !== 'undefined', hadDoc, 'requiring the module touches no DOM globals');
  ['buildPerches', 'planRoute', 'arcK', 'arcPoint', 'facingFor', 'bubblePlacement', 'idleDecision', 'idleDelay',
    'pickWander', 'settleSpot', 'stepBody', 'landingFor', 'orbitPoint', 'flingVelocity', 'neighborPerch', 'bestX']
    .forEach(name => assert.strictEqual(typeof R[name], 'function', name + ' is exported'));
  console.log('[PASS] The module loads in node and exports its pure helpers');

  const SIZE = R.SIZE;
  const HALF = SIZE.w / 2;

  // Intervals: merge overlaps, subtract blocked parts.
  {
    assert.deepStrictEqual(R.mergeIntervals([[5, 9], [0, 2], [1, 4], [12, 11]]), [[0, 4], [5, 9]]);
    assert.deepStrictEqual(R.freeIntervals(0, 100, [[10, 20], [15, 30], [90, 120]]), [[0, 10], [30, 90]]);
    assert.deepStrictEqual(R.freeIntervals(0, 100, [[-10, 200]]), []);
    assert.deepStrictEqual(R.freeIntervals(10, 5, []), [], 'an inverted range is empty');
    console.log('[PASS] Interval merge and subtraction');
  }

  // Perches: edges from rectangles, inset from rounded corners, tiny or
  // hidden rectangles dropped, and spots over controls blocked.
  const layout = () => {
    const items = [
      { key: 'tabs', kind: 'tabs', rect: { left: 16, top: 60, right: 364, bottom: 94 } },
      { key: 'counter', kind: 'counter', rect: { left: 16, top: 106, right: 364, bottom: 330 } },
      { key: 'w:a', kind: 'card', rect: { left: 16, top: 342, right: 184, bottom: 460 } },
      { key: 'w:b', kind: 'card', rect: { left: 196, top: 342, right: 364, bottom: 460 } },
      { key: 'w:c', kind: 'card', rect: { left: 16, top: 472, right: 364, bottom: 700 } },
      { key: 'footer', kind: 'footer', rect: { left: 16, top: 712, right: 364, bottom: 744 } },
      { key: 'gone', kind: 'card', rect: { left: 0, top: 0, right: 0, bottom: 0 } },
      { key: 'narrow', kind: 'card', rect: { left: 0, top: 10, right: 40, bottom: 20 } }
    ];
    const obstacles = [
      // two tab labels sitting right above the counter card
      { left: 20, top: 66, right: 120, bottom: 92 },
      { left: 126, top: 66, right: 230, bottom: 92 },
      // a button inside the tabs row card far to the right: not in the counter band
      { left: 340, top: 10, right: 360, bottom: 30 },
      // a hidden control
      { left: 200, top: 80, right: 200, bottom: 80 }
    ];
    return R.buildPerches(items, obstacles, SIZE);
  };
  {
    const perches = layout();
    assert.deepStrictEqual(perches.map(p => p.key), ['tabs', 'counter', 'w:a', 'w:b', 'w:c', 'footer'], 'empty and too-narrow rectangles are not edges');
    const counter = perches.find(p => p.key === 'counter');
    assert.strictEqual(counter.y, 107, 'feet sit on the border line');
    assert.strictEqual(counter.x1, 26, 'inset from the rounded corner');
    assert.strictEqual(counter.lo, 26 + HALF);
    assert.strictEqual(counter.hi, 354 - HALF);
    // The tab labels (20..230) block centers from 20 - 18 - 2 = 0 to 230 + 18 + 2 = 250.
    assert.deepStrictEqual(counter.free, [[250, 354 - HALF]], 'spots over the tab labels are blocked');
    assert.ok(!R.isFree(counter, 100) && R.isFree(counter, 300));
    assert.strictEqual(R.bestX(counter, 100), 250, 'the nearest free spot');
    assert.strictEqual(R.bestX(counter, 320), 320);
    const tabs = perches.find(p => p.key === 'tabs');
    assert.strictEqual(tabs.free.length, 1, 'controls lower down do not block the edge above them');
    assert.strictEqual(R.bestX({ free: [] }, 10), null, 'an edge that is all controls has no spot');
    const seat = R.buildPerches([{ key: 'seat', kind: 'seat', rect: { left: 161, top: 229, right: 348, bottom: 230 } }],
      [{ left: 161, top: 140, right: 348, bottom: 188 }], SIZE)[0];
    assert.strictEqual(seat.x1, 163, 'the seat beside the ring has square ends');
    assert.strictEqual(seat.free.length, 1, 'counter words above the seat do not block it');
    const crowded = R.buildPerches([{ key: 'seat', kind: 'seat', rect: { left: 161, top: 229, right: 348, bottom: 230 } }],
      [{ left: 161, top: 190, right: 348, bottom: 220 }], SIZE)[0];
    assert.deepStrictEqual(crowded.free, [], 'a week line in the way blocks the seat');
    console.log('[PASS] Edges come from live rectangles and stay off controls');
  }

  // Visibility inside the scrolled viewport.
  {
    const perches = layout();
    const view = { top: 60, bottom: 500 };
    const seen = perches.filter(p => R.inView(p, view)).map(p => p.key);
    assert.deepStrictEqual(seen, ['counter', 'w:a', 'w:b', 'w:c'], 'only edges whose buddy would be fully visible');
    assert.ok(!R.inView(perches[0], view), 'the head would be under the top bar');
    console.log('[PASS] Only edges inside the visible viewport count');
  }

  // Routes: walk along an edge, hop between edges, climb tall gaps edge by
  // edge, and walk first so hops stay short.
  {
    const perches = layout();
    const counter = perches.find(p => p.key === 'counter');
    let legs = R.planRoute(perches, { x: 260, y: counter.y, key: 'counter' }, { key: 'counter', x: 320 });
    assert.deepStrictEqual(legs, [{ type: 'walk', key: 'counter', x0: 260, x1: 320, y: 107 }], 'same edge: one walk');

    legs = R.planRoute(perches, { x: 100, y: 343, key: 'w:a' }, { key: 'w:b', x: 300 });
    assert.deepStrictEqual(legs.map(l => l.type), ['walk', 'hop', 'walk'], 'side-by-side cards: walk, hop across, walk');
    assert.ok(Math.abs(legs[1].x1 - legs[1].x0) <= 130, 'the hop across stays short');
    assert.strictEqual(legs[legs.length - 1].x1, 300);

    legs = R.planRoute(perches, { x: 200, y: 713, key: 'footer' }, { key: 'counter', x: 300 });
    const hops = legs.filter(l => l.type === 'hop');
    assert.ok(hops.length >= 3, 'a 600px climb goes edge by edge, got ' + hops.length + ' hops');
    hops.forEach(h => assert.ok(h.y0 - h.y1 <= 240 + 1e-9, 'each climb is one edge at a time'));
    assert.deepStrictEqual(hops.map(h => h.key), ['w:c', 'w:a', 'counter'], 'via the cards in between');
    assert.strictEqual(hops[hops.length - 1].key, 'counter');
    assert.strictEqual(legs[legs.length - 1].x1, 300);

    legs = R.planRoute(perches, { x: 150, y: 200, key: null }, { key: 'counter', x: 300 });
    assert.strictEqual(legs[0].type, 'hop', 'not on an edge: hop up first');
    assert.strictEqual(legs[0].y0, 200);

    assert.deepStrictEqual(R.planRoute(perches, { x: 1, y: 1, key: 'counter' }, { key: 'nope', x: 1 }), [], 'unknown goal');
    legs = R.planRoute(perches, { x: 260, y: 107, key: 'counter' }, { key: 'counter', x: 9999 });
    assert.strictEqual(legs[0].x1, counter.hi, 'targets are clamped onto the edge');
    console.log('[PASS] Routes walk, hop, climb edge by edge, and keep hops short');
  }

  // Hop arcs: start and end exactly; the top of the arc is `lift` above the
  // higher end, up or down.
  {
    const apex = (y0, y1, k) => {
      let min = Infinity;
      for (let i = 0; i <= 2000; i++) min = Math.min(min, R.arcPoint(0, y0, 100, y1, k, i / 2000).y);
      return min;
    };
    [[100, 100, 16], [100, 0, 14], [0, 220, 10], [300, 160, 30]].forEach(([y0, y1, lift]) => {
      const k = R.arcK(y0, y1, lift);
      const a = R.arcPoint(0, y0, 100, y1, k, 0);
      const b = R.arcPoint(0, y0, 100, y1, k, 1);
      near(a.x, 0); near(a.y, y0); near(b.x, 100); near(b.y, y1);
      near(apex(y0, y1, k), Math.min(y0, y1) - lift, 0.05, 'apex for ' + [y0, y1, lift]);
    });
    near(R.arcPoint(0, 0, 100, 0, R.arcK(0, 0, 20), 0.5).x, 50, 1e-9, 'constant horizontal speed');
    const k = R.arcK(100, 100, 16);
    near(R.hopDuration(k, 1500), Math.sqrt(2 * k / 1500), 1e-9, 'flight time follows gravity');
    assert.strictEqual(R.hopDuration(0), 0.22, 'never instant');
    assert.strictEqual(R.hopDuration(1e7), 0.95, 'never sluggish');
    assert.ok(R.hopLift(0, 0, 0, 200) < R.hopLift(0, 0, 0, 0), 'drops get a smaller bounce');
    console.log('[PASS] Hops fly true ballistic arcs with the right apex and timing');
  }

  // Facing follows travel and keeps the last direction when still.
  {
    assert.strictEqual(R.facingFor(5, 'left'), 'right');
    assert.strictEqual(R.facingFor(-5, 'right'), 'left');
    assert.strictEqual(R.facingFor(0, 'left'), 'left');
    assert.strictEqual(R.facingFor(0.2, undefined), 'right');
    console.log('[PASS] The buddy faces where it is going');
  }

  // The bubble opens away from edges, keeps its side while it fits, and
  // drops below the feet when there is no room above.
  {
    const base = { y: 300, width: 380, top: 0, bubbleW: 160, bubbleH: 44 };
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 60 }, base)).side, 'right');
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 330 }, base)).side, 'left', 'flips near the right edge');
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 190, prev: 'left' }, base)).side, 'left', 'keeps its side while it fits');
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 60, prev: 'left' }, base)).side, 'right', 'flips when it no longer fits');
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 190, bubbleW: 400 }, base)).side, 'right', 'too wide either way: the roomier side');
    assert.strictEqual(R.bubblePlacement(Object.assign({ x: 60 }, base)).vert, 'above');
    assert.strictEqual(R.bubblePlacement(Object.assign({}, base, { x: 60, y: 90, top: 20 })).vert, 'below', 'no room under the top bar');
    // Text it must not cover: above-right sits on the label, so it moves.
    const label = { left: 150, right: 360, top: 230, bottom: 262 };
    const pick = R.bubblePlacement(Object.assign({ x: 160, avoid: [label] }, base));
    assert.notDeepStrictEqual(pick, { side: 'right', vert: 'above' }, 'steps off the protected label');
    assert.deepStrictEqual(R.bubblePlacement(Object.assign({ x: 160, avoid: [{ left: 0, right: 10, top: 0, bottom: 10 }] }, base)),
      R.bubblePlacement(Object.assign({ x: 160 }, base)), 'far-away text changes nothing');
    console.log('[PASS] The speech bubble flips sides and drops below near edges');
  }

  // Idle beats: 8 to 15 seconds apart, naps after a quiet minute, waves for
  // a nudge, and no pose twice in a row.
  {
    const rand = seeded(7);
    for (let i = 0; i < 200; i++) {
      const d = R.idleDelay({ now: 1000, lastInteraction: 1000, rand });
      assert.ok(d >= 8000 && d <= 15000, 'delay in range: ' + d);
    }
    assert.strictEqual(R.idleDelay({ now: 55000, lastInteraction: 0, rand: () => 0.99 }), 5050, 'never sleeps past the nap point');
    assert.strictEqual(R.idleDelay({ now: 90000, lastInteraction: 0, rand: () => 0.5 }), 1200, 'nap due: soon');
    assert.strictEqual(R.idleDecision({ now: 61000, lastInteraction: 0, rand }), 'nap');
    assert.strictEqual(R.idleDecision({ now: 30000, lastInteraction: 0, rand: () => 0.1 }), 'wander', 'not quiet long enough to nap');
    assert.strictEqual(R.idleDecision({ now: 61000, lastInteraction: 0, nudge: true }), 'wave', 'a nudge outranks a nap');
    assert.strictEqual(R.idleDecision({ now: 0, lastInteraction: 0, rand: () => 0.5 }), 'look');
    assert.strictEqual(R.idleDecision({ now: 0, lastInteraction: 0, rand: () => 0.5, last: 'look' }), 'wander', 'no pose twice in a row');
    const seen = new Set();
    const r2 = seeded(3);
    for (let i = 0; i < 400; i++) seen.add(R.idleDecision({ now: 0, lastInteraction: 0, rand: r2 }));
    assert.deepStrictEqual(Array.from(seen).sort(), ['look', 'sit', 'wander', 'wave'], 'wander, sit, look around, wave');
    console.log('[PASS] Idle beats wander, sit, look, wave, and nap after a quiet minute');
  }

  // Wandering picks free spots on real edges, never the bottom of the window.
  {
    const perches = layout();
    perches.push(R.buildPerches([{ key: 'floor', kind: 'floor', rect: { left: 8, top: 598, right: 372, bottom: 600 } }], [], SIZE)[0]);
    const rand = seeded(11);
    for (let i = 0; i < 200; i++) {
      const spot = R.pickWander(perches, { x: 300, y: 107, key: 'counter' }, rand);
      assert.ok(spot && spot.key !== 'floor', 'never the floor');
      const p = perches.find(q => q.key === spot.key);
      assert.ok(R.isFree(p, spot.x), 'a free spot on ' + spot.key + ' at ' + spot.x);
    }
    assert.strictEqual(R.pickWander([], { x: 0, y: 0, key: null }, rand), null);
    console.log('[PASS] Wandering lands on free spots on real edges');
  }

  // Staying out of the way: fine where it is, slide along, or move edges.
  {
    const perches = layout();
    assert.strictEqual(R.settleSpot(perches, { x: 300, y: 107, key: 'counter' }), null, 'already out of the way');
    assert.deepStrictEqual(R.settleSpot(perches, { x: 200, y: 107, key: 'counter' }), { key: 'counter', x: 250 }, 'slides off the tab labels');
    const blocked = perches.map(p => (p.key === 'counter' ? Object.assign({}, p, { free: [] }) : p));
    const spot = R.settleSpot(blocked, { x: 200, y: 107, key: 'counter' });
    assert.ok(spot && spot.key !== 'counter', 'moves to another edge when this one is all controls');
    assert.ok(R.settleSpot(perches, { x: 200, y: 900, key: null }), 'not on an edge: finds one');
    console.log('[PASS] The buddy settles where it does not cover controls');
  }

  // Keyboard order: previous and next edge in reading order.
  {
    const perches = layout();
    assert.strictEqual(R.neighborPerch(perches, 'counter', 0, 0, 1).key, 'w:a');
    assert.strictEqual(R.neighborPerch(perches, 'w:a', 0, 0, 1).key, 'w:b', 'side by side: left then right');
    assert.strictEqual(R.neighborPerch(perches, 'counter', 0, 0, -1).key, 'tabs');
    assert.strictEqual(R.neighborPerch(perches, 'tabs', 0, 0, -1), null, 'nothing before the first edge');
    assert.strictEqual(R.neighborPerch(perches, null, 100, 200, 1).key, 'w:a', 'off an edge: the next one below');
    assert.strictEqual(R.neighborPerch(perches, null, 100, 200, -1).key, 'counter', 'off an edge: the one above');
    console.log('[PASS] Arrow keys step through edges in reading order');
  }

  // Falling: gravity, soft side bounces, and landing on the first edge the
  // feet cross on the way down.
  {
    const bounds = { left: HALF + 2, right: 360, top: 50 };
    let b = { x: 100, y: 100, vx: 0, vy: 0 };
    b = R.stepBody(b, 0.1, bounds, 1500);
    near(b.vy, 150, 1e-9); near(b.y, 115, 1e-9);
    b = R.stepBody({ x: 355, y: 100, vx: 400, vy: 0, rot: 10, spin: 100 }, 0.05, bounds, 1500);
    assert.strictEqual(b.x, 360, 'stops at the side');
    assert.ok(b.vx < 0, 'and bounces back');
    near(b.rot, 15, 1e-9, 'tumbles while flying');
    b = R.stepBody({ x: 100, y: 52, vx: 0, vy: -500 }, 0.02, bounds, 1500);
    assert.strictEqual(b.y, 50, 'never above the visible top');
    assert.ok(b.vy >= 0);

    const perches = layout();
    assert.strictEqual(R.landingFor(perches, 100, 300, 350).key, 'w:a');
    assert.strictEqual(R.landingFor(perches, 190, 300, 350), null, 'falls through the gap between cards');
    assert.strictEqual(R.landingFor(perches, 100, 350, 300), null, 'no landing on the way up');
    assert.strictEqual(R.landingFor(perches, 100, 0, 1000).key, 'tabs', 'the first edge crossed wins');
    console.log('[PASS] Drops and flings fall with gravity and land on the first edge below');
  }

  // A victory lap around the ring keeps the feet on the circle.
  {
    const top = R.orbitPoint(100, 100, 50, 0);
    near(top.x, 100); near(top.y, 50); assert.strictEqual(top.rot, 0);
    const right = R.orbitPoint(100, 100, 50, 90);
    near(right.x, 150); near(right.y, 100); assert.strictEqual(right.rot, 90);
    const bottom = R.orbitPoint(100, 100, 50, 180);
    near(bottom.x, 100); near(bottom.y, 150);
    const left = R.orbitPoint(100, 100, 50, 270);
    near(left.x, 50); near(left.y, 100);
    near(R.easeInOut(0), 0); near(R.easeInOut(1), 1); near(R.easeInOut(0.5), 0.5);
    console.log('[PASS] The victory lap runs clockwise around the ring');
  }

  // Fling speed from the last pointer samples.
  {
    const v = R.flingVelocity([{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 900 }, { x: 40, y: -20, t: 950 }, { x: 70, y: -40, t: 1000 }], 1000);
    near(v.x, 600, 1e-9); near(v.y, -400, 1e-9);
    assert.deepStrictEqual(R.flingVelocity([{ x: 0, y: 0, t: 0 }], 10), { x: 0, y: 0 }, 'one sample is a drop');
    assert.deepStrictEqual(R.flingVelocity([{ x: 0, y: 0, t: 0 }, { x: 90, y: 0, t: 40 }], 500), { x: 0, y: 0 }, 'a stale move is a drop');
    console.log('[PASS] Fling velocity comes from the last 100ms of movement');
  }

  // The character rig in shared/buddy.js: new parts hidden by default so the
  // seated buddy (and anywhere else the drawing is used) looks the same.
  {
    const B = fresh('shared/buddy.js');
    const svg = B.svg();
    ['buddy-svg', 'buddy-body-g', 'buddy-shackle', 'buddy-body', 'buddy-foot', 'buddy-eyes-open', 'buddy-eyes-happy',
      'buddy-eyes-closed', 'buddy-glint', 'buddy-cheek', 'buddy-mouth', 'buddy-sparkles', 'buddy-zz', 'buddy-drop']
      .forEach(c => assert.ok(svg.includes(c), 'keeps ' + c));
    ['buddy-rig', 'buddy-legs', 'buddy-leg-l', 'buddy-leg-r', 'buddy-shin', 'buddy-arms', 'buddy-arm-l', 'buddy-arm-r',
      'buddy-face', 'buddy-mouth-o', 'buddy-foot-still'].forEach(c => assert.ok(svg.includes(c), 'adds ' + c));
    assert.ok(/class="buddy-legs" display="none"/.test(svg), 'legs hidden unless the roaming CSS shows them');
    assert.ok(/class="buddy-arms" display="none"/.test(svg), 'arms hidden unless the roaming CSS shows them');
    assert.ok(/class="buddy-mouth-o"[^>]*display="none"/.test(svg), 'the yawn mouth starts hidden');
    assert.strictEqual((svg.match(/buddy-foot-still/g) || []).length, 2, 'two seated feet as before');
    assert.strictEqual((svg.match(/<g/g) || []).length, (svg.match(/<\/g>/g) || []).length, 'groups are balanced');
    assert.ok(svg.includes('viewBox="0 0 44 48"'), 'same viewBox');
    assert.strictEqual(B.RIG.viewH, 48);
    const feet = Number((svg.match(/class="buddy-foot" cx="14.6" cy="([\d.]+)" rx="[\d.]+" ry="([\d.]+)"/) || []).slice(1).reduce((a, b) => Number(a) + Number(b), 0));
    near(feet, B.RIG.feetY, 1e-9, 'RIG.feetY is where the roaming feet touch down');
    // The roaming box puts those feet at SIZE.foot px: 36 x 40 box, width-limited scale.
    const scale = Math.min(SIZE.w / B.RIG.viewW, SIZE.h / B.RIG.viewH);
    const top = (SIZE.h - B.RIG.viewH * scale) / 2;
    near(top + B.RIG.feetY * scale, SIZE.foot, 0.5, 'the module stands the feet where the drawing has them');
    console.log('[PASS] The character gains legs, arms, and a face rig without changing the seated look');
  }

  // Every pose the module sets has CSS; every rule is scoped to the roaming buddy.
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'popup', 'modules', 'buddy-roam.css'), 'utf8');
    R.ACTIONS.filter(a => a !== 'stand').forEach(a => assert.ok(css.includes('[data-action="' + a + '"]'), 'CSS for ' + a));
    const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'modules', 'buddy-roam.js'), 'utf8');
    const used = new Set();
    (js.match(/(?:pose|hold|setAction)\('([a-z]+)'/g) || []).forEach(m => used.add(m.replace(/.*'([a-z]+)'/, '$1')));
    (js.match(/act: '([a-z]+)'/g) || []).forEach(m => used.add(m.replace(/.*'([a-z]+)'/, '$1')));
    used.forEach(a => assert.ok(R.ACTIONS.includes(a), 'listed action: ' + a));
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
      .split('}').map(s => s.split('{')[0].trim()).filter(Boolean);
    selectors.forEach(sel => {
      if (sel.startsWith('@media') || sel.startsWith(':root[data-motion')) return;
      sel.split(',').forEach(one => {
        const s = one.trim();
        assert.ok(/\.buddy\.roam|\.buddy-dust|^\.buddy-layer \{?$|^\.buddy-layer$/.test(s) || s === '.buddy-layer', 'scoped selector: ' + s);
      });
    });
    console.log('[PASS] Every pose has CSS, scoped to the roaming buddy');
  }

  console.log('--- test/buddy-roam.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
