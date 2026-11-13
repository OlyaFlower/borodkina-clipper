// Wiring between a kit composition and HyperFrames: the prepared scene, image loading behind a
// build-ready promise, and the clock (a paused GSAP timeline plus hf-seek) that draws every layer at t.
//
// scripts/motion-render.sh puts the prepared files into the composition's assets/ (cover.jpg,
// depth.png, meta.json) and writes assets/scene.js, which sets window.__MOTION_SCENE to meta.json.

import { DURATION } from './loop.js';

/** The prepared meta.json (see motion/prepare/prepare.py). */
export function scene() {
  const value = window.__MOTION_SCENE;
  if (!value || typeof value !== 'object') throw new Error('motion kit: assets/scene.js did not load');
  return value;
}

/** Composition variables (data-composition-variables defaults, overridden by render --variables). */
export function variables() {
  try {
    return window.__hyperframes?.getVariables?.() ?? {};
  } catch {
    return {};
  }
}

export function loadImage(src) {
  const img = new Image();
  img.decoding = 'sync';
  img.src = src;
  return img.decode().then(() => img);
}

/**
 * Holds the render until `build` (an async function) has finished, then registers the timeline of
 * `compositionId` that draws every function returned by build at timeline time t.
 */
export function run(compositionId, build) {
  window.__hf = window.__hf || {};
  window.__hf.buildReady = window.__hf.buildReady || {};
  window.__hf.buildReady[`motion-kit-${compositionId}`] = build().then((layers) => {
    const renderAt = (t) => {
      for (const draw of layers) draw(t);
    };
    const tl = gsap.timeline({ paused: true });
    const clock = { t: 0 };
    tl.to(clock, { t: DURATION, duration: DURATION, ease: 'none', onUpdate: () => renderAt(clock.t) }, 0);
    window.addEventListener('hf-seek', (e) => renderAt(e.detail.time));
    renderAt(0);
    window.__timelines = window.__timelines || {};
    window.__timelines[compositionId] = tl;
  });
}
