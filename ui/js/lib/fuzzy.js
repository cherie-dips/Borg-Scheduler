// Fuzzy matching for the command palette (fzf-style subsequence scoring) and
// "did you mean" suggestions (edit distance).

// Score how well `query` matches `text`: higher is better, -1 means no match.
// Prefix matches win, then word-start matches, then contiguous runs.
export function score(query, text) {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  let s = 0, ti = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const wordStart = found === 0 || /[\s\-_./]/.test(t[found - 1]);
    run = found === ti ? run + 1 : 0;
    s += 10 + (wordStart ? 15 : 0) + run * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return s;
}

// Best matches of `query` among `items` (by `key(item)`), best first.
export function rank(query, items, key = (x) => x, limit = Infinity) {
  return items
    .map((item) => ({ item, s: Math.max(score(query, key(item)), ...(item.aliases || []).map((a) => score(query, a))) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.item);
}

export function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// The closest candidate if it is plausibly a typo, else null.
export function didYouMean(word, candidates) {
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const dd = distance(word.toLowerCase(), c.toLowerCase());
    if (dd < bestD) [best, bestD] = [c, dd];
  }
  return bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}
