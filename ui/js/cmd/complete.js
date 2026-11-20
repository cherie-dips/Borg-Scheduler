// Autocomplete for the prompt, which doubles as the command palette: what can come next at
// the cursor, plus fish-style "ghost" text for the best match.

import { COMMANDS, lookup } from './registry.js';
import { KEYS, canonicalKey } from './spec.js';
import { rank, score, didYouMean } from '../lib/fuzzy.js';
import { splitArgs, tokenize } from '../lib/parse.js';

// Returns { items: [{value, insert, hint, kind}], from, to, ghost, title }.
// Accepting item i replaces input[from, to) with items[i].insert.
export function complete(input, ctx) {
  const tokens = tokenize(input);
  const trailing = /\s$/.test(input) || input === '';
  const cur = trailing ? { text: '', start: input.length, end: input.length } : tokens[tokens.length - 1];
  const before = trailing ? tokens : tokens.slice(0, -1);

  // 1. the command word itself
  if (before.length === 0) {
    const visible = COMMANDS.filter((c) => !c.hidden);
    const list = cur.text ? rank(cur.text, visible, (c) => c.name) : visible;
    return result(list.map((c) => ({ value: c.name, insert: c.name + ' ', hint: c.summary, kind: 'command' })), cur, 'commands');
  }

  const cmd = lookup(before[0].text);
  if (!cmd) return { items: [], from: cur.start, to: cur.end, ghost: '', title: '' };

  // 2. key=value settings (schedule, edit)
  const eq = cur.text.indexOf('=');
  if (cmd.kv && eq > 0) {
    const key = canonicalKey(cur.text.slice(0, eq));
    const partial = cur.text.slice(eq + 1);
    const values = key ? valuesFor(key, ctx) : [];
    const list = partial ? values.filter((v) => score(partial, v.value) >= 0).sort((a, b) => score(partial, b.value) - score(partial, a.value)) : values;
    const head = cur.text.slice(0, eq + 1);
    return result(list.map((v) => ({ ...v, insert: head + v.value + ' ', kind: 'value' })), cur, key ? `${key}: ${KEYS[key].desc}` : '');
  }

  // 3. positional arguments, then settings
  const { positional } = splitArgs(before.slice(1));
  const spec = cmd.args?.[positional.length];
  const items = [];
  if (spec) for (const it of spec.complete(ctx)) items.push({ ...it, insert: it.value + ' ', kind: spec.name });
  if (cmd.kv && !(spec && positional.length === 0 && cur.text && !items.length)) {
    const used = new Set(before.slice(1).map((t) => canonicalKey(t.text.split('=')[0])).filter(Boolean));
    for (const [k, v] of Object.entries(KEYS)) {
      if (used.has(k) || (k === 'start' && cmd.kvNoStart)) continue;
      items.push({ value: `${k}=`, insert: `${k}=`, hint: v.desc, kind: 'setting' });
    }
  }
  const list = cur.text ? items.filter((i) => score(cur.text, i.value) >= 0).sort((a, b) => score(cur.text, b.value) - score(cur.text, a.value)) : items;
  const title = spec ? `${cmd.name} ${spec.name === 'job' ? '<job>' : `<${spec.name}>`}` : cmd.kv ? `${cmd.name} settings` : cmd.usage;
  return result(list, cur, title);
}

function valuesFor(key, ctx) {
  const k = KEYS[key];
  if (k.values) return k.values.map((value) => ({ value }));
  if (key === 'need' || key === 'prefer') {
    const pairs = new Set();
    for (const m of ctx.model?.machines || []) for (const [a, v] of Object.entries(m.attributes || {})) pairs.add(`${a}:${v}`);
    return [...pairs].sort().map((value) => ({ value, hint: 'machine attribute' }));
  }
  return k.hint ? [{ value: k.hint, hint: 'example' }] : [];
}

function result(items, cur, title) {
  const top = items[0];
  const typed = cur.text;
  let ghost = '';
  if (top && typed && top.insert.toLowerCase().startsWith(typed.toLowerCase())) ghost = top.insert.trimEnd().slice(typed.length);
  return { items: items.slice(0, 50), from: cur.start, to: cur.end, ghost, title };
}

// Applies item `it` from `complete()` to `input`.
export function accept(input, res, it) {
  return input.slice(0, res.from) + it.insert + input.slice(res.to).replace(/^\s+/, '');
}

// A short "did you mean" for an unknown command word.
export function suggestCommand(word) {
  return didYouMean(word, COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]));
}
