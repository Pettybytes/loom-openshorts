/**
 * Overlay GEOMETRY contract: the Header owns a dedicated upper region, the Hook
 * owns the video region, and neither can move or overlap the other.
 *
 * These are the assertions Bryan asked for, expressed against the layout module
 * the renderer actually uses — so a passing test is a statement about shipped
 * geometry, not about a fixture that happened to look right.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  HEADER_REGION,
  HOOK_REGION,
  HEADER_ANCHOR_PCT,
  HOOK_ANCHOR_PCT,
  HEADER_SAFE_INSET_PCT,
  HEADER_ALIGN,
  headerBand,
  headerUsableBand,
  headerAnchorPct,
  headerInnerTopPct,
  hookAnchorPct,
  headerBox,
  hookBox,
  layoutOverlays,
  overlaysCollide,
} from './overlayLayout.js';

const header = (over = {}) => ({ enabled: true, text: 'HEADER PREVIEW', position: 'top', ...over });
const hook = (over = {}) => ({ present: true, text: 'LOOK MA.. NO HANDS!', position: 'top', durationSec: 7, ...over });

// --- regions are disjoint by construction ----------------------------------

test('the two regions do not overlap', () => {
  assert.ok(HEADER_REGION.bottom <= HOOK_REGION.top,
    'the gap between the regions is the no-collision guarantee');
  assert.ok(HEADER_REGION.top < HEADER_REGION.bottom);
  assert.ok(HOOK_REGION.top < HOOK_REGION.bottom);
});

test('every declared Header anchor sits inside the Header region', () => {
  for (const [name, anchor] of Object.entries(HEADER_ANCHOR_PCT)) {
    assert.ok(anchor >= HEADER_REGION.top && anchor <= HEADER_REGION.bottom,
      `header anchor ${name}=${anchor} must be inside its region`);
  }
});

test('every declared Hook anchor sits inside the Hook region', () => {
  for (const [name, anchor] of Object.entries(HOOK_ANCHOR_PCT)) {
    assert.ok(anchor >= HOOK_REGION.top && anchor <= HOOK_REGION.bottom,
      `hook anchor ${name}=${anchor} must be inside its region`);
  }
});

test('a nonsense position falls back inside the region rather than off-screen', () => {
  assert.ok(headerAnchorPct('nonsense') >= HEADER_REGION.top);
  assert.ok(headerAnchorPct('nonsense') <= HEADER_REGION.bottom);
  assert.ok(headerAnchorPct(null) >= HEADER_REGION.top);
  assert.ok(hookAnchorPct('nonsense') >= HOOK_REGION.top);
});

test('the band-relative offset used for CSS `top` is inside the band', () => {
  for (const position of ['upper', 'top', 'nonsense']) {
    const inner = headerInnerTopPct(position);
    assert.ok(inner >= 0 && inner <= 100, `${position} -> ${inner}% must be inside the band`);
  }
  assert.ok(headerInnerTopPct('upper') < headerInnerTopPct('top'),
    'upper must sit above top');
});

// --- containment -----------------------------------------------------------

test('the Header stays inside the Header/top region', () => {
  for (const position of ['upper', 'top']) {
    const box = headerBox(header({ position }));
    assert.equal(box.region, 'header');
    assert.ok(box.topPct >= HEADER_REGION.top);
    assert.ok(box.bottomPct <= HEADER_REGION.bottom, 'the band is a hard floor');
  }
});

test('the Hook stays inside the Hook/video region', () => {
  for (const position of ['top', 'center', 'bottom']) {
    const box = hookBox(hook({ position }));
    assert.equal(box.region, 'hook');
    assert.ok(box.topPct >= HOOK_REGION.top, 'the Hook never rises into the Header region');
    assert.ok(box.topPct <= HOOK_REGION.bottom);
  }
});

test('an absent or disabled element produces no box at all', () => {
  assert.equal(headerBox(header({ enabled: false })), null);
  assert.equal(hookBox(hook({ present: false })), null);
});

// --- no collision ----------------------------------------------------------

test('Header and Hook shown together never collide, for every anchor pair', () => {
  for (const hp of ['upper', 'top']) {
    for (const kp of ['top', 'center', 'bottom']) {
      const layout = layoutOverlays({ header: header({ position: hp }), hook: hook({ position: kp }) });
      assert.equal(overlaysCollide(layout), false, `${hp} + ${kp} must not collide`);
      assert.ok(layout.header.bottomPct <= layout.hook.topPct,
        `header floor ${layout.header.bottomPct} must stay above hook top ${layout.hook.topPct}`);
    }
  }
});

// --- independence ----------------------------------------------------------

test('a larger, longer or multi-line Header cannot push into the Hook region', () => {
  const plain = headerBox(header());
  const huge = headerBox(header({ fontSize: 160, text: 'A VERY LONG HEADER THAT WOULD WRAP SEVERAL TIMES' }));
  // The box is the region, not the text: growing the text cannot move the floor.
  assert.equal(huge.bottomPct, plain.bottomPct);
  assert.ok(huge.bottomPct <= HEADER_REGION.bottom);
});

test('Header range styling does not move the Header box', () => {
  const plain = headerBox(header());
  const styled = headerBox(header({ spans: [{ start: 0, end: 6, size: 1.375 }] }));
  assert.deepEqual(styled, plain);
});

test('a large Hook does not move the Header', () => {
  const before = layoutOverlays({ header: header(), hook: hook({ size: 'S' }) });
  const after = layoutOverlays({ header: header(), hook: hook({ size: 'L', text: 'A MUCH BIGGER HOOK' }) });
  assert.deepEqual(after.header, before.header);
});

test('the Hook moving does not move the Header', () => {
  for (const position of ['top', 'center', 'bottom']) {
    const layout = layoutOverlays({ header: header(), hook: hook({ position }) });
    assert.deepEqual(layout.header, headerBox(header()));
  }
});

test('the Hook disappearing at its duration does not move the Header', () => {
  const during = layoutOverlays({ header: header(), hook: hook({ durationSec: 7 }), currentTime: 2 });
  const after = layoutOverlays({ header: header(), hook: hook({ durationSec: 7 }), currentTime: 30 });
  assert.ok(during.hook, 'the hook is on screen inside its window');
  assert.equal(after.hook, null, 'the hook clears after its duration');
  assert.deepEqual(after.header, during.header, 'the header is unmoved by the hook leaving');
});

test('the Header is stable while scrubbing the whole clip', () => {
  const samples = [0, 0.5, 2, 6.99, 7, 7.01, 8.8, 30];
  const boxes = samples.map((t) => layoutOverlays({ header: header(), hook: hook(), currentTime: t }).header);
  for (const box of boxes) assert.deepEqual(box, boxes[0]);
});

test('the Header does not depend on Hook state at all', () => {
  const alone = layoutOverlays({ header: header(), hook: null }).header;
  const together = layoutOverlays({ header: header(), hook: hook() }).header;
  assert.deepEqual(together, alone);
});

test('the Hook does not depend on Header state at all', () => {
  const alone = layoutOverlays({ header: null, hook: hook() }).hook;
  const together = layoutOverlays({ header: header({ position: 'upper' }), hook: hook() }).hook;
  assert.deepEqual(together, alone);
});

test('an empty preview produces no boxes and no collision', () => {
  const layout = layoutOverlays({});
  assert.equal(layout.header, null);
  assert.equal(layout.hook, null);
  assert.equal(overlaysCollide(layout), false);
});

test('the band spans the whole Header region', () => {
  const band = headerBand();
  assert.equal(band.topPct, HEADER_REGION.top);
  assert.equal(band.topPct + band.heightPct, HEADER_REGION.bottom);
});

// --- safe padding inside the region (round-2 polish) -----------------------

test('the usable band is inset from BOTH edges of the region', () => {
  const usable = headerUsableBand();
  assert.ok(usable.insetPct > 0, 'a safe inset must exist');
  assert.equal(usable.topPct - HEADER_REGION.top, usable.insetPct, 'safe top inset');
  assert.equal(HEADER_REGION.bottom - usable.bottomPct, usable.insetPct, 'safe bottom inset');
  assert.ok(usable.topPct > HEADER_REGION.top);
  assert.ok(usable.bottomPct < HEADER_REGION.bottom);
});

test('the safe inset is symmetric, so the region reads as intentionally padded', () => {
  const usable = headerUsableBand();
  const regionCentre = (HEADER_REGION.top + HEADER_REGION.bottom) / 2;
  const usableCentre = (usable.topPct + usable.bottomPct) / 2;
  assert.equal(usableCentre, regionCentre);
});

test('the default Header placement is CENTRED in the usable band', () => {
  const box = headerBox(header());
  assert.equal(box.position, 'top');
  assert.equal(box.align, 'center');
  assert.equal(HEADER_ALIGN.top, 'center');
});

test('the explicit upper anchor hugs the safe top inset, still padded', () => {
  const box = headerBox(header({ position: 'upper' }));
  assert.equal(box.align, 'flex-start');
  assert.equal(box.topPct, headerUsableBand().topPct);
  assert.ok(box.topPct >= HEADER_REGION.top + HEADER_SAFE_INSET_PCT, 'never touches the region top');
});

test('every anchor is clamped into the usable band, so padding cannot be breached', () => {
  const usable = headerUsableBand();
  for (const position of ['upper', 'top', 'nonsense', null, undefined]) {
    const anchor = headerAnchorPct(position);
    assert.ok(anchor >= usable.topPct, `${position} above safe inset`);
    assert.ok(anchor <= usable.bottomPct, `${position} below safe inset`);
  }
});

test('the renderer inset is expressed relative to the band and stays inside it', () => {
  const box = headerBox(header());
  assert.ok(box.insetInBandPct > 0 && box.insetInBandPct < 50,
    'top and bottom insets must leave room in the middle');
  for (const position of ['upper', 'top']) {
    const b = headerBox(header({ position }));
    assert.ok(b.insetInBandPct > 0 && b.insetInBandPct < 50);
  }
});

test('a large rich-text range stays contained inside the usable band', () => {
  const plain = headerBox(header());
  const big = headerBox(header({
    fontSize: 160,
    spans: [
      { start: 0, end: 6, size: 1.375 },
      { start: 7, end: 11, size: 0.9 },
      { start: 11, end: 14, font: 'Impact', size: 2.5 },
    ],
  }));
  // Geometry is owned by the region: oversized text cannot redefine it.
  assert.deepEqual(big.usable, plain.usable);
  assert.equal(big.insetInBandPct, plain.insetInBandPct);
  assert.equal(big.bottomPct, plain.bottomPct);
  assert.ok(big.bottomPct <= HEADER_REGION.bottom);
});

test('a small or absent range changes nothing about the geometry', () => {
  const plain = headerBox(header());
  assert.deepEqual(headerBox(header({ spans: [{ start: 0, end: 1, size: 0.3 }] })), plain);
  assert.deepEqual(headerBox(header({ spans: [] })), plain);
});

test('the Header still cannot enter the video region with the new padding', () => {
  for (const position of ['upper', 'top']) {
    const layout = layoutOverlays({ header: header({ position, fontSize: 160 }), hook: hook() });
    assert.ok(layout.header.bottomPct <= layout.hook.topPct);
    assert.equal(overlaysCollide(layout), false);
  }
});

test('the Hook still cannot enter the Header region', () => {
  const layout = layoutOverlays({ header: header(), hook: hook({ position: 'top' }) });
  assert.ok(layout.hook.topPct >= HEADER_REGION.bottom);
});

test('the padded Header remains independent of Hook visibility and scrubbing', () => {
  const before = layoutOverlays({ header: header(), hook: hook({ durationSec: 7 }), currentTime: 1 }).header;
  const after = layoutOverlays({ header: header(), hook: hook({ durationSec: 7 }), currentTime: 12 }).header;
  const hidden = layoutOverlays({ header: header(), hook: null }).header;
  assert.deepEqual(after, before);
  assert.deepEqual(hidden, before);
});

test('a short region degrades gracefully instead of inverting the band', () => {
  // The inset is capped at a third of the region, so the usable band can never
  // collapse or invert if the region is ever tightened.
  const usable = headerUsableBand();
  assert.ok(usable.heightPct > 0);
  assert.ok(usable.topPct < usable.bottomPct);
});
