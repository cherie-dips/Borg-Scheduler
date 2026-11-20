#!/usr/bin/env python3
"""Turns the CSV files written by borgsim into PNG charts (results/*.png).

    python3 tools/plot.py [results_dir]

Every chart has the same look: a light card with a left-aligned title, thin horizontal bars with
a rounded end, and the value at the tip of each bar. Blue marks what Borg does (and the best
result); grey marks the alternatives.
"""
import csv
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.offsetbox import AnnotationBbox, HPacker, TextArea  # noqa: E402
from matplotlib.patches import FancyBboxPatch, PathPatch  # noqa: E402
from matplotlib.path import Path  # noqa: E402
from matplotlib.ticker import FixedLocator, FuncFormatter, NullLocator  # noqa: E402
from matplotlib.transforms import blended_transform_factory  # noqa: E402

RESULTS = sys.argv[1] if len(sys.argv) > 1 else "results"

# Colours: blue, orange and aqua pass a colour-blindness check as a set.
SURFACE, BORDER = "#fcfcfb", "#e4e3dd"
INK, INK_2, MUTED = "#0b0b0b", "#52514e", "#898781"
GRID, BASELINE = "#ebeae4", "#c3c2b7"
BLUE = "#2a78d6"  # what Borg does, and the best result
GREY = "#cfcdc6"  # the alternatives
ORANGE, AQUA = "#eb6834", "#1baf7a"  # prod-only and non-prod-only cells

DPI = 220
SIZE = (4.8, 3.3)  # inches; the README shows two charts per row
WIDE = (9.8, 3.3)
BAR_PX = 58  # bar thickness cap, in pixels of the PNG
END_PX = 9  # radius of the rounded end
GAP_PX = 4  # surface gap between stacked segments

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Liberation Sans", "Helvetica", "DejaVu Sans"],
    "font.size": 9.5,
    "text.color": INK,
    "xtick.color": MUTED,
    "xtick.labelsize": 8.5,
    "xtick.major.size": 0,
    "xtick.major.pad": 4,
})


def load(name):
    path = os.path.join(RESULTS, name + ".csv")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return list(csv.DictReader(f))


def pct(a, b):
    return 100.0 * (a - b) / b


def signed(p):
    return f"{p:+.1f}%".replace("-", "\u2212")  # a real minus sign


def thousands(v, _=None):
    return "0" if v == 0 else f"{v / 1000:g}K"


# ---- layout -------------------------------------------------------------------------------------


def card(size, title, subtitle):
    """A figure drawn as a rounded light card, with a title and a one-line subtitle."""
    w, h = size
    fig = plt.figure(figsize=size, dpi=DPI)
    fig.patch.set_alpha(0)
    inch = fig.dpi_scale_trans
    fig.add_artist(FancyBboxPatch((0.02, 0.02), w - 0.04, h - 0.04, transform=inch,
                                  boxstyle="round,pad=0,rounding_size=0.12",
                                  facecolor=SURFACE, edgecolor=BORDER, linewidth=0.8, zorder=-10))
    fig.text(0.24, h - 0.36, title, transform=inch, size=12.5, weight="bold", va="baseline")
    fig.text(0.24, h - 0.58, subtitle, transform=inch, size=8.8, color=INK_2, va="baseline")
    return fig


def axes(fig, left, top, bottom=0.42, right=0.24):
    """Plot area, given margins in inches."""
    w, h = fig.get_size_inches()
    ax = fig.add_axes([left / w, bottom / h, (w - left - right) / w, (h - top - bottom) / h])
    ax.patch.set_alpha(0)
    for side in ax.spines.values():
        side.set_visible(False)
    ax.set_yticks([])
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    return ax


def px(ax):
    """Size of the plot area in pixels."""
    b = ax.get_position()
    w, h = ax.figure.get_size_inches()
    return b.width * w * DPI, b.height * h * DPI


def bar_height(ax, slots):
    """Bar thickness in data units: at most BAR_PX, and never more than 62% of a slot."""
    return min(0.62, BAR_PX / (px(ax)[1] / slots))


def hbar(ax, y, x0, x1, h, color, round_end=True, gap_start=False):
    """A horizontal bar from x0 to x1, square at the baseline and rounded at the data end."""
    to_axes = ax.transData + ax.transAxes.inverted()
    (ax0, ay0), (ax1, ay1) = to_axes.transform([(x0, y - h / 2), (x1, y + h / 2)])
    ay0, ay1 = min(ay0, ay1), max(ay0, ay1)
    wpx, hpx = px(ax)
    if gap_start:
        ax0 += GAP_PX / wpx
    rx = min(END_PX / wpx, (ax1 - ax0) / 2) if round_end else 0
    ry = min(END_PX / hpx, (ay1 - ay0) / 2) if round_end else 0
    k = 0.5523  # control-point distance for a quarter circle
    verts = [(ax0, ay0), (ax1 - rx, ay0),
             (ax1 - rx + k * rx, ay0), (ax1, ay0 + ry - k * ry), (ax1, ay0 + ry),
             (ax1, ay1 - ry),
             (ax1, ay1 - ry + k * ry), (ax1 - rx + k * rx, ay1), (ax1 - rx, ay1),
             (ax0, ay1), (ax0, ay0)]
    codes = [Path.MOVETO, Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO, Path.CLOSEPOLY]
    ax.add_patch(PathPatch(Path(verts, codes), transform=ax.transAxes, facecolor=color,
                           edgecolor="none", zorder=3))


def end_label(ax, x, y, value, note=None, strong=False):
    """The value (and an optional note) just past the end of a bar."""
    parts = [TextArea(value, textprops=dict(color=INK, size=9.5, weight="bold" if strong else "normal"))]
    if note:
        parts.append(TextArea(note, textprops=dict(color=INK_2, size=8.8)))
    box = HPacker(children=parts, sep=5, pad=0, align="baseline")
    ax.add_artist(AnnotationBbox(box, (x, y), xybox=(5, 0), boxcoords="offset points",
                                 box_alignment=(0, 0.5), frameon=False, pad=0, zorder=4))


def row_label(ax, y, text, sub=None):
    """Category name to the left of the plot, with an optional grey second line."""
    where = blended_transform_factory(ax.transAxes, ax.transData)
    lift = 5.5 if sub else 0
    ax.annotate(text, (0, y), xycoords=where, xytext=(-9, lift), textcoords="offset points",
                ha="right", va="center", size=9.5, color=INK)
    if sub:
        ax.annotate(sub, (0, y), xycoords=where, xytext=(-9, -6.5), textcoords="offset points",
                    ha="right", va="center", size=8, color=MUTED)


def group_label(fig, ax, y, text):
    """A small heading above a group of bars, aligned with the title."""
    where = blended_transform_factory(fig.dpi_scale_trans, ax.transData)
    ax.annotate(text.upper(), (0.24, y), xycoords=where, ha="left", va="center", size=7.6,
                color=MUTED, weight="bold", annotation_clip=False, zorder=5,
                bbox=dict(boxstyle="square,pad=0.25", facecolor=SURFACE, edgecolor="none"))


def legend(fig, items, y):
    """A row of colour keys under the subtitle."""
    inch, x = fig.dpi_scale_trans, 0.24
    for label, color in items:
        fig.add_artist(FancyBboxPatch((x, y - 0.045), 0.11, 0.11, transform=inch, facecolor=color,
                                      edgecolor="none", boxstyle="round,pad=0,rounding_size=0.025"))
        t = fig.text(x + 0.16, y, label, transform=inch, size=8.6, color=INK_2, va="center")
        x += 0.16 + t.get_window_extent(fig.canvas.get_renderer()).width / DPI + 0.22


def linear_x(ax, longest, label_room=1.0, step=5000):
    """x from 0 with room for end labels; gridlines every `step`; a baseline at 0."""
    w = px(ax)[0] / DPI
    hi = longest / (1 - label_room / w)
    ax.set_xlim(0, hi)
    ax.xaxis.set_major_locator(FixedLocator([v for v in range(0, int(hi) + 1, step)]))
    ax.xaxis.set_major_formatter(FuncFormatter(thousands))
    ax.axvline(0, color=BASELINE, linewidth=1.0, zorder=2)


def save(fig, name):
    out = os.path.join(RESULTS, name + ".png")
    fig.savefig(out, dpi=DPI, transparent=True)
    plt.close(fig)
    print("wrote", out)


# ---- charts -------------------------------------------------------------------------------------


def ranked(name, title, subtitle, rows, left=1.75, step=5000):
    """Bars for (label, sub, value, note, highlighted) rows, top to bottom."""
    fig = card(SIZE, title, subtitle)
    ax = axes(fig, left=left, top=0.85)
    n = len(rows)
    ax.set_ylim(n - 0.5, -0.5)
    linear_x(ax, max(r[2] for r in rows), step=step)
    h = bar_height(ax, n)
    for y, (label, sub, value, note, hi) in enumerate(rows):
        hbar(ax, y, 0, value, h, BLUE if hi else GREY)
        end_label(ax, value, y, f"{value:,}", note, strong=hi)
        row_label(ax, y, label, sub)
    save(fig, name)


def policies(rows):
    by = {r["policy"]: r for r in rows}
    best = int(by["hybrid"]["p90_machines"])
    names = {"hybrid": "Hybrid (ours)", "worst_fit": "Worst fit (E-PVM)", "best_fit": "Best fit"}
    out = []
    for key in sorted(by, key=lambda k: int(by[k]["p90_machines"])):
        r, n = by[key], int(by[key]["p90_machines"])
        sub = f"stranded: {float(r['stranded_cpu_pct']):.0f}% CPU, {float(r['stranded_ram_pct']):.0f}% RAM"
        out.append((names.get(key, key), sub, n, None if n == best else signed(pct(n, best)), n == best))
    ranked("policies", "Scoring policy (§3.2)",
           "Machines needed to fit the workload · p90 of 11 seeds · fewer is better", out, left=1.85)


def segregation(rows):
    fig = card(SIZE, "One shared cell vs. separate cells (Fig. 5)",
               "Machines needed · p90 of 11 seeds · fewer is better")
    legend(fig, [("shared cell", BLUE), ("prod-only cell", ORANGE), ("non-prod-only cell", AQUA)],
           y=SIZE[1] - 0.83)
    ax = axes(fig, left=1.75, top=1.08)
    groups = [("1", "with reclamation · how Borg runs"), ("0", "limits only")]
    slots = []  # (y, kind, values)
    y = 0.0
    for rec, heading in groups:
        g = {r["config"]: int(r["p90_machines"]) for r in rows if r.get("reclamation", "0") == rec}
        if not g:
            continue
        slots.append((y, "heading", heading))
        slots.append((y + 0.85, "shared", g))
        slots.append((y + 1.85, "split", g))
        y += 3.0
    ax.set_ylim(y - 0.55, -0.45)
    longest = max(s[2]["segregated_total"] for s in slots if s[1] == "split")
    linear_x(ax, longest)
    h = bar_height(ax, y - 0.1)
    for yy, kind, g in slots:
        if kind == "heading":
            group_label(fig, ax, yy + 0.05, g)
        elif kind == "shared":
            hbar(ax, yy, 0, g["shared"], h, BLUE)
            end_label(ax, g["shared"], yy, f"{g['shared']:,}", strong=True)
            row_label(ax, yy, "One shared cell")
        else:
            prod, total = g["prod_only"], g["segregated_total"]
            hbar(ax, yy, 0, prod, h, ORANGE, round_end=False)
            hbar(ax, yy, prod, total, h, AQUA, gap_start=True)
            end_label(ax, total, yy, f"{total:,}", signed(pct(total, g['shared'])))
            row_label(ax, yy, "Prod + non-prod cells", f"{prod:,} + {g['nonprod_only']:,}")
    save(fig, "segregation")


def buckets(rows):
    exact = next(int(r["p90_machines"]) for r in rows if r["variant"] == "exact")
    out = []
    for r in rows:
        n = int(r["p90_machines"])
        if r["variant"] == "exact":
            out.append(("Exact requests", "what Borg does", n, None, True))
        else:
            size = round(1 / float(r["min_bucket"]))
            out.append((f"Buckets from 1/{size}", "of a machine", n, signed(pct(n, exact)), False))
    ranked("buckets", "Exact vs. bucketed requests (Fig. 8)",
           "Requests rounded up to a power of two · machines needed · paper: +30–50%", out,
           step=10000)


def hybrid_alpha(rows):
    base = int(rows[0]["p90_machines"])
    out = []
    for r in rows:
        a, n = float(r["alpha"]), int(r["p90_machines"])
        label = f"α = {a:g}" + (" (best fit)" if a == 0 else " (default)" if a == 10 else "")
        out.append((label, None, n, None if a == 0 else signed(pct(n, base)), a == 10))
    ranked("hybrid_alpha", "Hybrid policy: the stranding weight α",
           "Machines needed · p90 of 3 seeds · change vs. α = 0", out, left=1.45)


def reclamation(rows):
    g = {r["variant"]: int(r["p90_machines"]) for r in rows}
    on, off = g["with_reclamation"], g["without_reclamation"]
    ranked("reclamation", "Resource reclamation (Fig. 10)",
           "Non-prod work may use what prod reserves but does not use · p90 of 11 seeds",
           [("With reclamation", "what Borg does", on, None, True),
            ("Without", "every task counts at its limit", off, signed(pct(off, on)), False)])


def scalability(rows):
    fig = card(WIDE, "Scheduler optimizations (§3.4)",
               "One full scheduling pass: 20,000 trace tasks onto 12,480 machines · log scale")
    names = {"none": "No optimizations", "equivalence_classes": "Equivalence classes",
             "score_cache": "Score cache", "relaxed_randomization": "Relaxed randomization",
             "all": "All three"}
    n = len(rows)
    left_w = (WIDE[0] - 1.75 - 0.24 - 0.6) / 2
    panels = [
        ("time for one pass", [float(r["elapsed_ms"]) for r in rows], 4,
         [10, 100, 1000, 10000], lambda v: f"{v:g} ms" if v < 1000 else f"{v / 1000:g} s",
         lambda v: f"{v:.0f} ms" if v < 1000 else f"{v / 1000:.1f} s", "faster"),
        ("feasibility checks + score computations",
         [int(r["feasibility_checks"]) + int(r["score_computations"]) for r in rows], 50000,
         [1e5, 1e6, 1e7, 1e8, 1e9], lambda v: {1e5: "100K", 1e6: "1M", 1e7: "10M", 1e8: "100M", 1e9: "1B"}[v],
         lambda v: f"{v / 1e6:.0f}M" if v >= 1e7 else f"{v / 1e6:.1f}M" if v >= 1e6 else f"{v / 1e3:.0f}K",
         "fewer"),
    ]
    for i, (heading, values, lo, ticks, tick_fmt, val_fmt, word) in enumerate(panels):
        x0 = 1.75 + i * (left_w + 0.6)
        ax = axes(fig, left=x0, top=1.02, right=WIDE[0] - x0 - left_w)
        ax.set_xscale("log")
        ax.set_xlim(lo, max(values) * 9)
        ax.set_ylim(n - 0.5, -0.5)
        ax.xaxis.set_major_locator(FixedLocator(ticks))
        ax.xaxis.set_minor_locator(NullLocator())
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _, f=tick_fmt: f(v)))
        fig.text(x0, WIDE[1] - 0.86, heading.upper(), transform=fig.dpi_scale_trans, size=7.6,
                 color=MUTED, weight="bold", va="baseline")
        h = bar_height(ax, n)
        for y, (r, v) in enumerate(zip(rows, values)):
            hi = r["variant"] == "all"
            hbar(ax, y, lo, v, h, BLUE if hi else GREY)
            note = f"{values[0] / v:,.0f}× {word}" if hi else None
            end_label(ax, v, y, val_fmt(v), note, strong=hi)
            if i == 0:
                row_label(ax, y, names.get(r["variant"], r["variant"]))
    save(fig, "scalability")


def main():
    for name, chart in [("policies", policies), ("segregation", segregation), ("buckets", buckets),
                        ("scalability", scalability), ("hybrid_alpha", hybrid_alpha),
                        ("reclamation", reclamation)]:
        if rows := load(name):
            chart(rows)


if __name__ == "__main__":
    main()
