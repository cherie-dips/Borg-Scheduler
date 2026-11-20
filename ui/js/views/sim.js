// 5 sim: the Plan A simulation results (results/*.csv) as text charts with the paper's claims.

import { esc, int, num } from '../lib/format.js';
import { cols, patch } from '../lib/dom.js';
import { simpleBar } from '../ui/widgets.js';

export default {
  id: 'sim',
  title: 'sim',
  panels: [{ id: 'results', title: 'simulation results · Plan A (Google trace 2011, cell compaction)' }],
  ticks: false,

  render(shell, P) {
    const p = P.results;
    const r = shell.store.results;
    if (!r) {
      shell.store.loadResults().then(() => shell.render());
      return patch(p.body, '<p class="mute">loading results…</p>');
    }
    if (!Object.values(r).some(Boolean)) {
      return patch(p.body, `<div class="empty-state"><p class="es-title">No simulation results yet.</p>
        <p>Run Plan A, then reload: <b>make sim && ./build/bin/borgsim --workload trace all</b></p>
        <p>The borgmaster serves the CSV files from <b>results/</b>.</p></div>`);
    }
    const W = Math.max(16, Math.min(60, cols(p.body) - 34));
    const chart = (rows) => {
      const max = Math.max(...rows.map((x) => x.value), 1);
      return rows.map((x) => `<div class="meter" style="grid-template-columns:22ch max-content minmax(0,1fr)"><span class="lbl">${esc(x.label)}</span>${simpleBar(x.value / max, W, x.cls || 'fill')}<span>${esc(x.text ?? int(x.value))}</span></div>`).join('');
    };
    const pctv = (a, b) => `${a >= b ? '+' : ''}${num((100 * (a - b)) / b, 1)}%`;
    const card = (title, ref, body, finding) => `<section class="panel" style="margin:1.2em 0 .4em"><h3 class="ptitle"><span class="name">${esc(title)}</span><span class="meta">${esc(ref)}</span></h3>${body}${finding ? `<p class="dim" style="margin-top:.4em">▸ ${finding}</p>` : ''}</section>`;
    const out = [];

    if (r.workload?.[0]) {
      const w = r.workload[0];
      out.push(card('workload', 'snapshot packed from scratch for every experiment (§5)', `
        <dl class="kv"><dt>source</dt><dd>${esc(w.source)} · ${int(w.machines)} machines · ${int(w.tasks)} tasks (${int(w.prod_tasks)} prod)</dd>
        <dt>requested</dt><dd>cpu ${Math.round((100 * w.cpu_requested) / w.cpu_capacity)}% · ram ${Math.round((100 * w.ram_requested) / w.ram_capacity)}% of the cell</dd>
        <dt>method</dt><dd>${int(w.seeds)} seeds per configuration, p90 of the smallest cell that fits</dd></dl>`));
    }
    if (r.policies) {
      const best = r.policies.find((x) => x.policy === 'best_fit'), hy = r.policies.find((x) => x.policy === 'hybrid');
      out.push(card('scoring policies', '§3.2 · machines needed, lower is better',
        chart(r.policies.map((x) => ({ label: x.policy, value: x.p90_machines, cls: x.policy === 'hybrid' ? 'fill ok' : 'fill' }))) +
        `<p class="mute">stranded at the same size: ${r.policies.map((x) => `${x.policy} cpu ${num(x.stranded_cpu_pct, 1)}% / ram ${num(x.stranded_ram_pct, 1)}%`).join(' · ')}</p>`,
        best && hy ? `hybrid vs best fit: <b>${pctv(hy.p90_machines, best.p90_machines)}</b> machines (paper: hybrid packs 3–5% better than best fit)` : ''));
    }
    if (r.segregation) {
      const g = (cfg, rec) => r.segregation.find((x) => x.config === cfg && Number(x.reclamation || 0) === rec)?.p90_machines;
      const rows = [];
      for (const rec of [1, 0]) {
        if (g('shared', rec) == null) continue;
        const tag = rec ? 'reclamation' : 'limits only';
        rows.push({ label: `shared · ${tag}`, value: g('shared', rec), cls: 'fill ok' });
        rows.push({ label: `separate · ${tag}`, value: g('segregated_total', rec), cls: 'fill', text: `${int(g('segregated_total', rec))} (${pctv(g('segregated_total', rec), g('shared', rec))})` });
      }
      out.push(card('segregating prod and non-prod', 'Fig. 5', chart(rows),
        'separate cells need more machines, mostly because non-prod work can no longer use resources that prod reserves but leaves idle (paper: +20–30% in the median cell)'));
    }
    if (r.buckets) {
      const exact = r.buckets.find((x) => x.variant === 'exact');
      out.push(card('bucketed requests', 'Fig. 8 · rounding requests up to powers of two',
        chart(r.buckets.map((x) => ({ label: x.variant === 'exact' ? 'exact requests' : `buckets ≥ 1/${Math.round(1 / x.min_bucket)}`, value: x.p90_machines, cls: x.variant === 'exact' ? 'fill ok' : 'fill', text: x.variant === 'exact' ? int(x.p90_machines) : `${int(x.p90_machines)} (${pctv(x.p90_machines, exact.p90_machines)})` }))),
        'fine-grained requests save machines (paper: buckets would need 30–50% more resources)'));
    }
    if (r.reclamation) {
      const g = Object.fromEntries(r.reclamation.map((x) => [x.variant, x.p90_machines]));
      out.push(card('resource reclamation', 'Fig. 10',
        chart([{ label: 'with reclamation', value: g.with_reclamation, cls: 'fill ok' }, { label: 'without', value: g.without_reclamation, cls: 'fill', text: `${int(g.without_reclamation)} (${pctv(g.without_reclamation, g.with_reclamation)})` }]),
        'non-prod work scheduled into reserved-but-unused resources (reservations from an assumed usage model)'));
    }
    if (r.scalability) {
      const max = Math.max(...r.scalability.map((x) => x.elapsed_ms));
      const rows = r.scalability.map((x) => `<div class="meter" style="grid-template-columns:22ch max-content minmax(0,1fr)"><span class="lbl">${esc(x.variant.replace(/_/g, ' '))}</span>${simpleBar(Math.log10(1 + x.elapsed_ms) / Math.log10(1 + max), W, 'fill')}<span>${int(x.elapsed_ms)} ms · ${int(x.feasibility_checks)} checks</span></div>`).join('');
      out.push(card('scheduler optimizations', '§3.4 · one full pass, log scale', rows,
        'equivalence classes and relaxed randomization cut the work by orders of magnitude; our score is cheap, so the cache alone costs more than it saves'));
    }
    if (r.hybrid_alpha) {
      out.push(card('hybrid stranding weight α', 'ablation · α = 0 is best fit',
        chart(r.hybrid_alpha.map((x) => ({ label: `α = ${x.alpha}${x.alpha === 10 ? ' (default)' : ''}`, value: x.p90_machines, cls: x.alpha === 10 ? 'fill ok' : 'fill' }))),
        'penalising stranded CPU/RAM keeps improving packing until about α = 10'));
    }
    patch(p.body, out.join(''));
  },

  list() {
    return null;
  },

  hints() {
    return [];
  },
};
