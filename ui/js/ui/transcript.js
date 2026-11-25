// A guided demo, printed like the output of a command: its title, then every step with all
// that was said under it. Nothing is ever replaced, so an earlier step can be read again. The
// pane follows the newest line for as long as that line is in view, and leaves the scroll
// position alone once someone has scrolled away from it.
//
// Colour shows progress only: a finished step is green, the running one cyan, a failure red.

import { capital, esc, sentence } from '../lib/format.js';

// "In a terminal, run: tools/cell.sh kill-master" -> label and command
function askParts(text) {
  const m = /^(.*?)\brun:\s*(.+)$/i.exec(text);
  return m ? { label: m[1].replace(/[,:\s]+$/, ''), cmd: m[2].trim() } : { label: text, cmd: '' };
}

// A line as a sentence. One that starts with the name of a demo's job or user ("demo-ann now
// uses …") keeps its first letter: names are not capitalised.
const asSentence = (s) => (/^demo-/.test(s) ? `${s}${/[.!?]$/.test(s) ? '' : '.'}` : sentence(s));

// "Finished · 3 tasks moved · its jobs stay …" -> ["3 tasks moved."]
function resultLines(text) {
  return String(text || '').split(' · ')
    .map((s) => s.trim().replace(/^(finished|stopped early:?|stopped)\s*/i, ''))
    .filter((s) => s && !/its jobs stay|"clean up" removes/i.test(s))
    .map(asSentence);
}

const DOCKER = /with docker/i;
const bare = (s) => s.replace(/^\(|\)$/g, '');
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const MARK = { done: '✓', now: '▶', fail: '✗', halt: '■' };

// d: the demo (key, title, blurb, steps, secs). v: its last run, or null when it has not run
// yet ({stage, lines, status, result, started, ended, cleaned}). paper: the section of the
// paper it shows. note: why it cannot run right now. leftovers: demo jobs still in the cell.
export function transcriptHtml(d, v, { paper = '', note = '', leftovers = 0 } = {}) {
  const status = v ? v.status : 'ready';
  const n = d.steps.length;
  const at = !v ? 0 : status === 'ok' ? n + 1 : v.stage;
  const lines = v?.lines || [];
  // While the demo runs, the newest thing said is marked.
  let newest = -1;
  if (status === 'running') {
    lines.forEach((l, i) => {
      if (l.kind === 'say') newest = i;
    });
  }
  const dockerAlt = lines.find((l) => l.kind === 'aside' && DOCKER.test(l.text));

  function lineHtml(l, i, live) {
    if (l.kind === 'say') return `<p class="say${i === newest ? ' new' : ''}">${esc(l.text)}</p>`;
    if (l.kind === 'ask') {
      const { label, cmd } = askParts(l.text);
      if (!live) return `<p>Done by hand${cmd ? `: <code>${esc(cmd)}</code>` : `: ${esc(lower(label))}`}</p>`;
      return `<div class="ask"><h3>YOUR TURN</h3><p>${esc(cmd ? `${label}, run:` : sentence(label))}</p>
        ${cmd ? `<div class="cmd"><code>$ ${esc(cmd)}</code><button type="button" class="btn sm" data-act="copy" data-cmd="${esc(cmd)}">COPY</button></div>` : ''}
        ${dockerAlt ? `<p>${esc(capital(bare(dockerAlt.text)))}</p>` : ''}</div>`;
    }
    return DOCKER.test(l.text) ? '' : `<p>${esc(asSentence(bare(l.text)))}</p>`;
  }

  // Things said before step 1: what an earlier demo left and was cleared first.
  const before = lines.map((l, i) => (l.stage < 1 && l.kind === 'aside' ? lineHtml(l, i, false) : '')).join('');
  const pre = v && status === 'running' && at === 0 && !before ? '<div class="tx-pre"><p>Starting…</p></div>' : before ? `<div class="tx-pre">${before}</div>` : '';

  const items = d.steps.map((title, i) => {
    const k = i + 1;
    let state = '';
    if (k < at || (status === 'ok' && k <= n)) state = 'done';
    else if (k === at && status === 'running') state = 'now';
    else if (k === at && status === 'failed') state = 'fail';
    else if (k === at && status === 'stopped') state = 'halt';
    const body = lines.map((l, j) => (l.stage === k ? lineHtml(l, j, state === 'now') : '')).join('');
    return `<li class="st ${state}"><p class="st-t"><span class="st-n">[${k}/${n}]</span><span>${esc(sentence(title))}</span><span class="st-m">${MARK[state] || ''}</span></p>${body ? `<div class="st-say">${body}</div>` : ''}</li>`;
  }).join('');

  const stay = leftovers ? '<p>Its jobs are still in the cell, so you can look around. CLEAN UP removes them.</p>' : '';
  const secs = v?.ended ? Math.max(1, Math.round((v.ended - v.started) / 1000)) : 0;
  let result = '';
  if (v && status === 'ok') {
    const left = stay || (v.cleaned ? '<p>Its jobs were removed from the cell.</p>' : '');
    result = `<div class="result ok"><h3>✓ FINISHED IN ${secs} S</h3>${resultLines(v.result).map((s) => `<p>${esc(s)}</p>`).join('')}${left}</div>`;
  } else if (v && status === 'failed') {
    const why = resultLines(v.result);
    result = `<div class="result bad"><h3>✗ STOPPED EARLY</h3>${(why.length ? why : ['Something went wrong.']).map((s) => `<p>${esc(s)}</p>`).join('')}${stay ? '<p>CLEAN UP removes what it started.</p>' : ''}</div>`;
  } else if (v && status === 'stopped') {
    result = '<div class="result halt"><h3>■ STOPPED</h3><p>What the demo had started was removed.</p></div>';
  } else if (!v) {
    result = note
      ? `<div class="result halt"><h3>NOT AVAILABLE HERE</h3><p>${esc(note).replace(/(https?:\/\/\S+)/, '<a href="$1">$1</a>')}</p></div>`
      : `<p class="tx-hint">Press RUN to start. It takes about ${d.secs} seconds.</p>`;
  }
  if (v && note && status !== 'running') result += `<p class="tx-hint">${esc(note)}</p>`;

  return `<div class="tx">
    ${v ? `<p class="tx-cmd">$ demo ${esc(d.key)}</p>` : ''}
    <h3 class="tx-title">${esc(d.title)}${paper ? `<span>paper ${esc(paper)}</span>` : ''}</h3>
    <p class="tx-blurb">${esc(sentence(d.blurb))}</p>
    ${pre}<ol class="steps">${items}</ol>${result}</div>`;
}

// ---- following the newest line ------------------------------------------------------------------

// What a follower should be looking at: the result, else a question for the presenter, else
// the newest line, else the current step.
function latest(box) {
  return box.querySelector('.result') || box.querySelector('.ask') || box.querySelector('.st-say p.new') || box.querySelector('.st.now');
}

// Is the newest line in view (or is there nothing to scroll)?
export function atLatest(box) {
  if (box.scrollHeight <= box.clientHeight + 2) return true;
  const el = latest(box);
  if (!el) return box.scrollTop < 4;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  return r.bottom <= b.bottom + 4 && r.bottom >= b.top + 4;
}

// Scrolls just enough to show the newest line, with the title of the next step under it.
export function showLatest(box) {
  const el = latest(box);
  if (!el) {
    box.scrollTop = 0;
    return;
  }
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  const room = el.matches('.result, .ask') ? 16 : 56; // under a line: leave the next step's title in view
  if (r.bottom > b.bottom - room) box.scrollTop += r.bottom - (b.bottom - room);
  else if (r.top < b.top + 12) box.scrollTop -= b.top + 12 - r.top;
}
