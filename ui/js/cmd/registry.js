// Every command the prompt understands. Each one is also reachable from a key or a click; the
// help overlay and the palette are generated from this table, so nothing can drift out of date.
//
// ctx = { model, api, ui, settings } is provided by the app (see ui/app.js).

import { KEYS, WORKLOADS, applyArgs, specOf } from './spec.js';
import { BLANK, PRESETS, clone, presetByKey, uniqueName } from '../core/presets.js';
import { BOOT, EFFECTS, THEMES } from '../core/settings.js';
import { parseNumber, parseWhen } from '../lib/parse.js';
import { clock, dur, num } from '../lib/format.js';

export const POLICIES = {
  hybrid: 'best fit that avoids stranding CPU or RAM (default)',
  best_fit: 'pack machines as tightly as possible',
  worst_fit: 'spread load (E-PVM); leaves headroom, fragments',
};

export const VIEWS = {
  home: { key: '1', title: 'home', blurb: 'progress of every job at a glance' },
  jobs: { key: '2', title: 'jobs', blurb: 'manage jobs and inspect their tasks' },
  machines: { key: '3', title: 'machines', blurb: 'CPU and RAM per machine, failures' },
  log: { key: '4', title: 'log', blurb: 'every scheduling event, live' },
  sim: { key: '5', title: 'simulation', blurb: 'the paper\'s experiments, rerun on Google\'s trace' },
};

// ---- argument resolution -------------------------------------------------------------------

export function findJob(model, name) {
  if (!name) return { error: null };
  const n = name.toLowerCase();
  const jobs = model?.jobs || [];
  const exact = jobs.find((j) => j.name.toLowerCase() === n || String(j.id) === n);
  if (exact) return { value: exact };
  const pre = jobs.filter((j) => j.name.toLowerCase().startsWith(n));
  if (pre.length === 1) return { value: pre[0] };
  if (pre.length > 1) return { error: `"${name}" matches ${pre.map((j) => j.name).join(', ')}: type more of the name` };
  return { error: `no job called "${name}"${jobs.length ? ` (jobs: ${jobs.slice(0, 6).map((j) => j.name).join(', ')}${jobs.length > 6 ? ', …' : ''})` : ' (there are no jobs yet)'}` };
}

export function findMachine(model, name) {
  const n = String(name || '').toLowerCase();
  const ms = model?.machines || [];
  const exact = ms.find((m) => m.name.toLowerCase() === n || String(m.id) === n);
  if (exact) return { value: exact };
  const pre = ms.filter((m) => m.name.toLowerCase().startsWith(n) || m.name.toLowerCase().endsWith(n));
  if (n && pre.length === 1) return { value: pre[0] };
  return { error: `no machine called "${name}" (machines: ${ms.map((m) => m.name).join(', ') || 'none yet'})` };
}

// The job named in the command, or the one selected in the UI.
function jobArg(ctx, inv, verb) {
  const name = inv.args.positional[0];
  if (name) return findJob(ctx.model, name);
  const sel = ctx.ui.selectedJob();
  if (sel) return { value: sel };
  return { error: `${verb} which job? Type ${verb} and press Tab to pick one, or select a job first` };
}

// ---- completers ----------------------------------------------------------------------------

const jobItems = (filter = () => true) => (ctx) =>
  (ctx.model?.jobs || []).filter(filter).map((j) => ({ value: j.name, hint: `${j.status} · prio ${j.priority} · ${j.tasks} task(s)` }));
const machineItems = (ctx) =>
  (ctx.model?.machines || []).map((m) => ({ value: m.name, hint: `${m.status} · ${m.taskList.length} task(s)` }));
const fromObject = (obj) => () => Object.entries(obj).map(([value, hint]) => ({ value, hint }));
const whenItems = () => {
  const d = new Date(Date.now() + 15 * 60_000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(Math.floor(d.getMinutes() / 15) * 15).padStart(2, '0')}`;
  return [
    { value: 'now', hint: 'immediately' }, { value: 'in 30s', hint: 'in thirty seconds' },
    { value: 'in 5m', hint: 'in five minutes' }, { value: `at ${hhmm}`, hint: 'at a time of day' },
  ];
};

// ---- the commands ----------------------------------------------------------------------------

export const COMMANDS = [
  {
    name: 'help', aliases: ['?', 'man', 'h'], group: 'basics',
    summary: 'show all commands and keys, or how one command works',
    usage: 'help [command]', examples: ['help', 'help schedule'],
    args: [{ name: 'command', complete: (ctx) => COMMANDS.map((c) => ({ value: c.name, hint: c.summary })) }],
    run(ctx, inv) {
      const name = inv.args.positional[0];
      if (!name) return ctx.ui.openHelp();
      const c = lookup(name);
      if (!c) return ctx.ui.fail(`no command called "${name}"`);
      ctx.ui.print([
        { cls: 'hl', text: `${c.name} — ${c.summary}` },
        { text: `usage:    ${c.usage}` },
        c.aliases?.length ? { text: `aliases:  ${c.aliases.join(', ')}` } : null,
        ...(c.examples || []).map((e, i) => ({ text: `${i ? '          ' : 'examples: '}${e}` })),
        ...(c.more || []).map((t) => ({ cls: 'dim', text: t })),
      ].filter(Boolean));
    },
  },
  {
    name: 'schedule', aliases: ['new', 'run', 'submit', 'create'], group: 'jobs',
    summary: 'create a job (opens a form; add -y to skip it)',
    usage: 'schedule [preset|name] [key=value …] [-y]',
    examples: ['schedule', 'schedule web', 'schedule crawler tasks=10 start=1m', 'schedule etl prio=batch work=cpu dur=2m -y'],
    more: [`presets: ${PRESETS.map((p) => p.key).join(', ')}`, `settings: ${Object.keys(KEYS).join(', ')}`],
    args: [{ name: 'preset or name', complete: () => PRESETS.map((p) => ({ value: p.key, hint: `preset: ${p.blurb}` })) }],
    kv: true,
    run(ctx, inv) {
      const first = inv.args.positional[0];
      const preset = first && presetByKey(first);
      const taken = (ctx.model?.jobs || []).map((j) => j.name);
      let base = preset ? clone(preset.spec) : { ...clone(BLANK), name: first || '' };
      if (!base.user) base.user = 'you';
      if (!inv.args.options.name && base.name) base.name = uniqueName(base.name, taken);
      const { spec, delay, errors } = applyArgs(base, inv.args.options);
      if (errors.length) return ctx.ui.fail(errors.join('; '));
      if (inv.args.flags.has('y') || inv.args.flags.has('yes')) return ctx.ui.submitJob(spec, delay);
      ctx.ui.openForm({ mode: 'new', spec, delay });
    },
  },
  {
    name: 'edit', aliases: ['update', 'change'], group: 'jobs',
    summary: 'change a job: priority applies in place, resources restart its tasks',
    usage: 'edit <job> [key=value …] [-y]', examples: ['edit web-frontend', 'edit analytics prio=prod', 'edit web tasks=5 -y'],
    args: [{ name: 'job', complete: jobItems() }], kv: true, kvNoStart: true,
    run(ctx, inv) {
      const r = jobArg(ctx, inv, 'edit');
      if (r.error) return ctx.ui.fail(r.error);
      const { spec, errors } = applyArgs(specOf(r.value), inv.args.options, { allowStart: false });
      if (errors.length) return ctx.ui.fail(errors.join('; '));
      if (inv.args.flags.has('y') || inv.args.flags.has('yes')) return ctx.ui.applyEdit(r.value, spec);
      ctx.ui.openForm({ mode: 'edit', job: r.value, spec });
    },
  },
  {
    name: 'reschedule', aliases: ['resched', 'rerun', 'restart', 'retry'], group: 'jobs',
    summary: 'run a job again or later: moves a waiting start, restarts a live job, reruns a finished one',
    usage: 'reschedule <job> [now | in 5m | at 14:30] [-y]',
    examples: ['reschedule analytics', 'reschedule crawler in 2m', 'reschedule db at 18:00 -y'],
    args: [{ name: 'job', complete: jobItems() }, { name: 'when', complete: whenItems }],
    run(ctx, inv) {
      const r = jobArg(ctx, inv, 'reschedule');
      if (r.error) return ctx.ui.fail(r.error);
      const words = inv.args.positional.slice(1);
      if (!words.length && !inv.args.flags.has('y')) return ctx.ui.openReschedule(r.value);
      const w = parseWhen(words);
      if (w.error) return ctx.ui.fail(w.error);
      return ctx.ui.reschedule(r.value, w.value, { confirm: !inv.args.flags.has('y') });
    },
  },
  {
    name: 'kill', aliases: ['stop'], group: 'jobs',
    summary: 'stop a job; it stays in the history',
    usage: 'kill <job> [-y]', examples: ['kill crawler', 'kill crawler -y'],
    args: [{ name: 'job', complete: jobItems((j) => !j.done) }],
    run(ctx, inv) {
      const r = jobArg(ctx, inv, 'kill');
      if (r.error) return ctx.ui.fail(r.error);
      return ctx.ui.killJob(r.value, { confirm: !inv.args.flags.has('y') });
    },
  },
  {
    name: 'rm', aliases: ['delete', 'del', 'remove'], group: 'jobs',
    summary: 'delete a job (stops it first if it is running)',
    usage: 'rm <job> [-y]', examples: ['rm mem-hog', 'rm crawler -y'],
    args: [{ name: 'job', complete: jobItems() }],
    run(ctx, inv) {
      const r = jobArg(ctx, inv, 'rm');
      if (r.error) return ctx.ui.fail(r.error);
      return ctx.ui.removeJob(r.value, { confirm: !inv.args.flags.has('y') });
    },
  },
  {
    name: 'show', aliases: ['open', 'job', 'inspect'], group: 'jobs',
    summary: 'open a job: its tasks, machines, progress and history',
    usage: 'show <job>', examples: ['show web-frontend'],
    args: [{ name: 'job', complete: jobItems() }],
    run(ctx, inv) {
      const r = jobArg(ctx, inv, 'show');
      if (r.error) return ctx.ui.fail(r.error);
      ctx.ui.setView('jobs', { select: r.value.id });
    },
  },
  {
    name: 'fail', aliases: ['crash', 'break'], group: 'cell',
    summary: 'simulate a machine failure; its tasks move elsewhere',
    usage: 'fail <machine> [seconds] [-y]', examples: ['fail borglet-3', 'fail 3 60 -y'],
    args: [{ name: 'machine', complete: machineItems }, { name: 'seconds', complete: () => [{ value: '20', hint: 'default' }, { value: '60', hint: 'one minute' }] }],
    run(ctx, inv) {
      const name = inv.args.positional[0];
      const r = name ? findMachine(ctx.model, name) : ctx.ui.selectedMachine() ? { value: ctx.ui.selectedMachine() } : { error: 'fail which machine? e.g. fail borglet-3 (Tab lists them)' };
      if (r.error) return ctx.ui.fail(r.error);
      let secs = 20;
      if (inv.args.positional[1]) {
        const s = parseNumber(inv.args.positional[1], { min: 3, max: 600, name: 'seconds' });
        if (s.error) return ctx.ui.fail(s.error);
        secs = s.value;
      }
      return ctx.ui.failMachine(r.value, secs, { confirm: !inv.args.flags.has('y') });
    },
  },
  {
    name: 'policy', aliases: ['scoring'], group: 'cell',
    summary: 'show or change how the scheduler picks machines',
    usage: 'policy [hybrid | best_fit | worst_fit]', examples: ['policy', 'policy best_fit'],
    args: [{ name: 'policy', complete: fromObject(POLICIES) }],
    async run(ctx, inv) {
      const p = inv.args.positional[0];
      if (!p) {
        const cur = ctx.model?.raw.policy;
        return ctx.ui.print([{ text: `scoring policy: ${cur || '?'}` },
          ...Object.entries(POLICIES).map(([k, v]) => ({ cls: k === cur ? 'hl' : 'dim', text: `  ${k === cur ? '▶' : ' '} ${k.padEnd(9)} ${v}` }))]);
      }
      const name = p.replace('-', '_').toLowerCase();
      if (!(name in POLICIES)) return ctx.ui.fail(`policy must be one of ${Object.keys(POLICIES).join(', ')}`);
      await ctx.ui.setPolicy(name);
    },
  },
  {
    name: 'status', aliases: ['st', 'info'], group: 'cell',
    summary: 'print a one-screen summary of the cell',
    usage: 'status', examples: ['status'],
    run(ctx) {
      const m = ctx.model;
      if (!m) return ctx.ui.fail('no data yet: the borgmaster has not answered');
      const r = m.raw;
      ctx.ui.print([
        { cls: 'hl', text: `cell local · policy ${r.policy} · ${m.counts.machinesUp}/${m.counts.machines} machines up` },
        { text: `cpu  ${num(r.allocated.cpu)}/${num(r.capacity.cpu)} cores allocated · ram ${Math.round(r.allocated.ram)}/${Math.round(r.capacity.ram)} MB` },
        { text: `jobs ${m.groups.running.length} running · ${m.groups.queued.length} queued · ${m.groups.completed.length} completed · ${m.groups.failed.length} failed` },
        { text: `tasks ${m.counts.running} running · ${m.counts.queued} queued · ${m.counts.done} finished · ${m.counts.failed} failed` },
      ]);
    },
  },
  {
    name: 'history', aliases: ['hist', 'done'], group: 'jobs',
    summary: 'list finished jobs with their outcome and run time',
    usage: 'history', examples: ['history'],
    run(ctx) {
      const done = (ctx.model?.jobs || []).filter((j) => j.done);
      if (!done.length) return ctx.ui.print([{ cls: 'dim', text: 'no finished jobs yet' }]);
      ctx.ui.print(done.map((j) => ({
        cls: j.status === 'failed' ? 'err' : j.status === 'killed' ? 'dim' : 'ok',
        text: `${j.status.padEnd(9)} ${j.name.padEnd(16)} finished ${clock(j.finished_at)} · ran ${dur(j.elapsed)}${j.runs > 1 ? ` · run #${j.runs}` : ''}`,
      })));
    },
  },
  ...Object.entries(VIEWS).map(([id, v]) => ({
    name: id, aliases: { home: ['dash', 'top', 'overview'], jobs: ['ls', 'ps'], machines: ['nodes', 'cell'], log: ['events', 'tail'], sim: ['results', 'experiments'] }[id],
    group: 'views', summary: `go to the ${v.title} view (key ${v.key}): ${v.blurb}`,
    usage: `${id}${id === 'jobs' || id === 'log' || id === 'machines' ? ' [filter]' : ''}`, examples: [id],
    run(ctx, inv) {
      ctx.ui.setView(id, { filter: inv.args.positional.join(' ') || undefined });
    },
  })),
  {
    name: 'theme', aliases: ['colors', 'colour', 'color'], group: 'look',
    summary: 'switch the colour theme', usage: 'theme [name]', examples: ['theme amber'],
    args: [{ name: 'theme', complete: fromObject(THEMES) }],
    run(ctx, inv) {
      const t = inv.args.positional[0];
      const names = Object.keys(THEMES);
      if (!t) {
        const next = names[(names.indexOf(ctx.settings.get().theme) + 1) % names.length];
        ctx.settings.set({ theme: next });
        return ctx.ui.ok(`theme: ${next} (${THEMES[next]})`);
      }
      if (!(t in THEMES)) return ctx.ui.fail(`theme must be one of ${names.join(', ')}`);
      ctx.settings.set({ theme: t });
      ctx.ui.ok(`theme: ${t}`);
    },
  },
  {
    name: 'fx', aliases: ['effects', 'crt'], group: 'look',
    summary: 'turn CRT effects on or off', usage: 'fx [on | off] | fx <effect> [on | off]',
    examples: ['fx off', 'fx scanlines off', 'fx flicker on'],
    args: [{ name: 'effect', complete: () => [{ value: 'on', hint: 'scanlines + glow' }, { value: 'off', hint: 'no effects' }, ...fromObject(EFFECTS)()] },
      { name: 'on/off', complete: () => [{ value: 'on' }, { value: 'off' }] }],
    run(ctx, inv) {
      const [a, b] = inv.args.positional.map((s) => s.toLowerCase());
      const s = ctx.settings;
      if (!a) {
        return ctx.ui.print(Object.entries(EFFECTS).map(([k, v]) => ({ cls: s.get()[k] ? 'hl' : 'dim', text: `  ${s.get()[k] ? 'on ' : 'off'}  ${k.padEnd(10)} ${v}` })));
      }
      if (a === 'on' || a === 'off') {
        const on = a === 'on';
        s.set({ scanlines: on, glow: on, flicker: false, crt: on && s.get().crt });
        return ctx.ui.ok(`effects ${a}`);
      }
      if (!(a in EFFECTS)) return ctx.ui.fail(`effect must be one of ${Object.keys(EFFECTS).join(', ')}, or on/off`);
      const on = b ? b === 'on' : !s.get()[a];
      s.set({ [a]: on });
      ctx.ui.ok(`${a} ${on ? 'on' : 'off'}`);
    },
  },
  {
    name: 'settings', aliases: ['prefs', 'config', 'options'], group: 'look',
    summary: 'theme, effects, keys and boot screen in one panel', usage: 'settings', examples: ['settings'],
    run: (ctx) => ctx.ui.openSettings(),
  },
  {
    name: 'tour', aliases: ['demo'], group: 'basics',
    summary: 'schedule a short scripted scenario that ends in preemption',
    usage: 'tour [-y]', examples: ['tour'],
    run: (ctx, inv) => ctx.ui.runDemo({ confirm: !inv.args.flags.has('y') }),
  },
  {
    name: 'undo', aliases: [], group: 'jobs',
    summary: 'undo the last change (key u)', usage: 'undo', examples: ['undo'],
    run: (ctx) => ctx.ui.undo(),
  },
  {
    name: 'pause', aliases: ['resume', 'freeze'], group: 'basics',
    summary: 'pause or resume live updates (key space)', usage: 'pause', examples: ['pause'],
    run: (ctx) => ctx.ui.act('pause'),
  },
  {
    name: 'safe', aliases: ['readonly'], group: 'look',
    summary: 'safe mode: make the UI read-only for demos', usage: 'safe [on | off]', examples: ['safe on'],
    args: [{ name: 'on/off', complete: () => [{ value: 'on', hint: 'block every change' }, { value: 'off', hint: 'allow changes' }] }],
    run(ctx, inv) {
      const a = (inv.args.positional[0] || '').toLowerCase();
      const on = a ? a === 'on' : !ctx.settings.get().safeMode;
      if (a && a !== 'on' && a !== 'off') return ctx.ui.fail('safe takes on or off');
      ctx.settings.set({ safeMode: on });
      ctx.ui.ok(on ? 'safe mode on: the UI is read-only' : 'safe mode off: changes allowed');
    },
  },
  {
    name: 'clear', aliases: ['cls'], group: 'basics', summary: 'clear the console', usage: 'clear', examples: ['clear'],
    run: (ctx) => ctx.ui.clearConsole(),
  },
  {
    name: 'boot', aliases: ['reboot'], group: 'basics', summary: 'replay the boot screen', usage: 'boot', examples: ['boot'],
    run: (ctx) => ctx.ui.replayBoot(),
  },
  {
    name: 'about', aliases: ['version'], group: 'basics', summary: 'what this is', usage: 'about', examples: ['about'],
    run(ctx) {
      ctx.ui.print([
        { cls: 'hl', text: 'mini-borg · a small replica of Google\'s Borg cluster manager' },
        { text: 'Verma et al., "Large-scale cluster management at Google with Borg", EuroSys 2015.' },
        { cls: 'dim', text: 'C++ borgmaster + borglets (cgroup v2) in Docker; this UI talks to the master\'s REST API.' },
      ]);
    },
  },
  {
    name: 'exit', aliases: ['quit', 'logout'], group: 'basics', summary: 'leave', usage: 'exit', examples: ['exit'], hidden: true,
    run(ctx) {
      ctx.ui.print([{ cls: 'hl', text: 'You cannot leave the Collective. Resistance is futile.' },
        { cls: 'dim', text: '(Close the browser tab to log off.)' }]);
    },
  },
];

const BY_NAME = new Map();
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases || [])]) BY_NAME.set(n.toLowerCase(), c);
export const lookup = (word) => BY_NAME.get(String(word || '').toLowerCase());
export const commandWords = () => [...BY_NAME.keys()];

export const GROUP_TITLES = { basics: 'basics', jobs: 'jobs', cell: 'cell', views: 'views', look: 'look & feel' };
export { WORKLOADS, BOOT };
