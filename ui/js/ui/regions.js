// Regions: named parts of the page that are redrawn only when their HTML changed. A view is
// built once; after that each region is filled by `put`, so nothing moves under the pointer,
// inputs keep what was typed, and task chips can slide to their new place.

import { swap } from './cellview.js';

let cache = {}; // the HTML last put into each region, by element id

export const $ = (id) => document.getElementById(id);

// Puts html into a region when it changed; returns true when it did.
export function put(id, html) {
  const el = $(id);
  if (!el || cache[id] === html) return false;
  cache[id] = html;
  el.innerHTML = html;
  return true;
}

// Like put, but task chips slide from their old place to the new one.
export function putAnimated(id, html) {
  const el = $(id);
  if (!el || cache[id] === html) return false;
  swap(el, html, { animate: cache[id] != null });
  cache[id] = html;
  return true;
}

// Forgets what was drawn, except the regions named in `keep` (they are still on the page).
export function forget(keep = []) {
  const next = {};
  for (const id of keep) if (id in cache) next[id] = cache[id];
  cache = next;
}
