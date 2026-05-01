#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TLDR Shield — Eval Chart Generator
====================================
Generates evaluation charts from the full 25-service battery results.
Run after scan_full_battery.py completes.

Output: eval/charts/*.png
"""

import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

OUT_DIR = os.path.join(os.path.dirname(__file__), "charts")
os.makedirs(OUT_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Results hardcoded from scan_full_battery.py run (2025-05-01)
# ---------------------------------------------------------------------------

RESULTS = [
    # service, grade, expected, basic_rating, basic_p, basic_r, deep_rating, deep_p, deep_r
    ("Discord",       "D", "RISKY", "RISKY", 1.00, 0.67, "RISKY", 1.00, 0.67),
    ("GitHub",        "B", "RISKY", "RISKY", 0.67, 1.00, "RISKY", 0.67, 1.00),
    ("Twitter/X",     "F", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
    ("Google",        "E", "RISKY", "RISKY", 1.00, 0.67, "RISKY", 1.00, 0.67),
    ("LinkedIn",      "D", "RISKY", "RISKY", 1.00, 0.67, "RISKY", 1.00, 0.67),
    ("PayPal",        "D", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
    ("Spotify",       "C", "RISKY", "RISKY", 0.67, 1.00, "RISKY", 0.67, 1.00),
    ("Netflix",       "D", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
    ("TikTok",        "D", "RISKY", "RISKY", 0.75, 1.00, "RISKY", 0.75, 1.00),
    ("Zoom",          "D", "RISKY", "RISKY", 1.00, 0.67, "RISKY", 1.00, 0.67),
    ("DuckDuckGo",    "A", "SAFE",  "SAFE",  1.00, 1.00, "SAFE",  1.00, 1.00),
    ("Signal",        "A", "OKAY",  "SAFE",  0.00, 0.00, "OKAY",  1.00, 1.00),
    ("Proton Mail",   "A", "OKAY",  "OKAY",  1.00, 1.00, "OKAY",  1.00, 1.00),
    ("Wikipedia",     "B", "OKAY",  "OKAY",  1.00, 1.00, "OKAY",  1.00, 1.00),
    ("Mullvad VPN",   "B", "SAFE",  "SAFE",  1.00, 1.00, "SAFE",  1.00, 1.00),
    ("Mozilla",       "B", "SAFE",  "SAFE",  1.00, 1.00, "SAFE",  1.00, 1.00),
    ("Apple",         "C", "RISKY", "SAFE",  0.00, 0.00, "RISKY", 0.50, 1.00),
    ("Reddit",        "C", "RISKY", "RISKY", 1.00, 0.67, "RISKY", 1.00, 1.00),
    ("Steam",         "C", "RISKY", "OKAY",  1.00, 0.50, "RISKY", 1.00, 1.00),
    ("Microsoft",     "E", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 0.67),
    ("Twitch",        "D", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
    ("Yahoo",         "E", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
    ("Epic Games",    "F", "OKAY",  "OKAY",  1.00, 1.00, "OKAY",  1.00, 1.00),
    ("Snap",          "F", "RISKY", "RISKY", 0.67, 0.50, "RISKY", 1.00, 1.00),
    ("Roblox",        "F", "RISKY", "RISKY", 1.00, 1.00, "RISKY", 1.00, 1.00),
]

NAMES      = [r[0] for r in RESULTS]
GRADES     = [r[1] for r in RESULTS]
EXPECTED   = [r[2] for r in RESULTS]
BASIC_RAT  = [r[3] for r in RESULTS]
BASIC_P    = [r[4] for r in RESULTS]
BASIC_R    = [r[5] for r in RESULTS]
DEEP_RAT   = [r[6] for r in RESULTS]
DEEP_P     = [r[7] for r in RESULTS]
DEEP_R     = [r[8] for r in RESULTS]

COLORS = {
    "SAFE":  "#2ecc71",
    "OKAY":  "#f39c12",
    "RISKY": "#e74c3c",
}

GRADE_COLORS = {
    "A": "#27ae60", "B": "#2ecc71", "C": "#f39c12",
    "D": "#e67e22", "E": "#e74c3c", "F": "#8e1a0e",
}

# ---------------------------------------------------------------------------
# Chart 1: BASIC vs DEEP — Overall Metrics
# ---------------------------------------------------------------------------

def chart1_overall():
    fig, ax = plt.subplots(figsize=(8, 5))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")

    basic_acc   = sum(1 for i in range(25) if BASIC_RAT[i] == EXPECTED[i]) / 25
    deep_acc    = sum(1 for i in range(25) if DEEP_RAT[i]  == EXPECTED[i]) / 25
    basic_prec  = sum(BASIC_P) / 25
    deep_prec   = sum(DEEP_P)  / 25
    basic_rec   = sum(BASIC_R) / 25
    deep_rec    = sum(DEEP_R)  / 25

    metrics = ["Rating Accuracy", "Avg Precision", "Avg Recall"]
    basic_vals = [basic_acc, basic_prec, basic_rec]
    deep_vals  = [deep_acc,  deep_prec,  deep_rec]

    x = np.arange(len(metrics))
    w = 0.32

    bars1 = ax.bar(x - w/2, basic_vals, w, label="BASIC (flash alone)",
                   color="#3498db", alpha=0.85, zorder=3)
    bars2 = ax.bar(x + w/2, deep_vals,  w, label="DEEP (ensemble)",
                   color="#9b59b6", alpha=0.85, zorder=3)

    for bar in list(bars1) + list(bars2):
        h = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, h + 0.012,
                f"{h:.0%}", ha="center", va="bottom",
                fontsize=11, fontweight="bold", color="white")

    ax.set_ylim(0, 1.12)
    ax.set_xticks(x)
    ax.set_xticklabels(metrics, color="white", fontsize=12)
    ax.set_ylabel("Score", color="white", fontsize=11)
    ax.set_title("BASIC vs DEEP Scan — Overall Performance (25 Services)",
                 color="white", fontsize=13, fontweight="bold", pad=14)
    ax.tick_params(colors="white")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
    ax.spines[:].set_color("#444")
    ax.grid(axis="y", color="#334", zorder=0)
    ax.legend(framealpha=0.2, labelcolor="white", fontsize=10)

    out = os.path.join(OUT_DIR, "chart1_overall.png")
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved: {out}")


# ---------------------------------------------------------------------------
# Chart 2: Per-service DEEP Precision & Recall
# ---------------------------------------------------------------------------

def chart2_per_service():
    fig, ax = plt.subplots(figsize=(14, 6))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")

    x = np.arange(25)
    w = 0.38

    bars_p = ax.bar(x - w/2, DEEP_P, w, label="Precision", color="#3498db", alpha=0.85, zorder=3)
    bars_r = ax.bar(x + w/2, DEEP_R, w, label="Recall",    color="#e74c3c", alpha=0.85, zorder=3)

    # colour bars by match / miss
    for i, (bp, br) in enumerate(zip(bars_p, bars_r)):
        ok = DEEP_RAT[i] == EXPECTED[i]
        if not ok:
            bp.set_edgecolor("yellow"); bp.set_linewidth(2)
            br.set_edgecolor("yellow"); br.set_linewidth(2)

    ax.set_ylim(0, 1.18)
    ax.set_xticks(x)
    ax.set_xticklabels(NAMES, rotation=45, ha="right", color="white", fontsize=8)
    ax.set_ylabel("Score", color="white", fontsize=11)
    ax.set_title("DEEP Scan — Per-Service Precision & Recall (25 Services)",
                 color="white", fontsize=13, fontweight="bold", pad=12)
    ax.tick_params(colors="white")
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
    ax.spines[:].set_color("#444")
    ax.grid(axis="y", color="#334", zorder=0)
    ax.legend(framealpha=0.2, labelcolor="white", fontsize=10)
    ax.text(0.99, 0.97, "Yellow border = rating mismatch",
            transform=ax.transAxes, color="yellow", fontsize=8,
            ha="right", va="top")

    out = os.path.join(OUT_DIR, "chart2_per_service_deep.png")
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved: {out}")


# ---------------------------------------------------------------------------
# Chart 3: False Negative / False Positive pillar breakdown
# ---------------------------------------------------------------------------

def chart3_error_breakdown():
    fn_counts = {
        "dark_patterns": 8, "data_selling": 3,
        "content_ownership": 3, "ai_training": 1,
    }
    fp_counts = {
        "data_selling": 6, "content_ownership": 1, "data_retention": 1,
    }

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")

    for ax, counts, title, color in [
        (axes[0], fn_counts, "False Negatives\n(Missed Real Violations)", "#e74c3c"),
        (axes[1], fp_counts, "False Positives\n(Wrongly Flagged)",        "#f39c12"),
    ]:
        ax.set_facecolor("#16213e")
        pillars = list(counts.keys())
        vals    = list(counts.values())
        bars = ax.barh(pillars, vals, color=color, alpha=0.85, zorder=3)
        for bar, v in zip(bars, vals):
            ax.text(bar.get_width() + 0.05, bar.get_y() + bar.get_height() / 2,
                    str(v), va="center", color="white", fontweight="bold", fontsize=12)
        ax.set_xlim(0, max(vals) + 1.5)
        ax.set_title(title, color="white", fontsize=12, fontweight="bold")
        ax.tick_params(colors="white")
        ax.spines[:].set_color("#444")
        ax.grid(axis="x", color="#334", zorder=0)
        ax.set_xlabel("Count (across BASIC + DEEP, 25 services)",
                      color="white", fontsize=9)

    fig.suptitle("Error Analysis — What TLDR Shield Gets Wrong",
                 color="white", fontsize=14, fontweight="bold", y=1.02)

    out = os.path.join(OUT_DIR, "chart3_error_breakdown.png")
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved: {out}")


# ---------------------------------------------------------------------------
# Chart 4: Grade distribution + detection rate
# ---------------------------------------------------------------------------

def chart4_grade_distribution():
    from collections import Counter, defaultdict

    grade_counts = Counter(GRADES)
    grade_order  = ["A", "B", "C", "D", "E", "F"]

    # deep recall per grade
    grade_recall = defaultdict(list)
    for i, g in enumerate(GRADES):
        grade_recall[g].append(DEEP_R[i])
    avg_recall = {g: sum(v) / len(v) for g, v in grade_recall.items()}

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")

    # Bar: service count per grade
    ax1.set_facecolor("#16213e")
    grades_present = [g for g in grade_order if g in grade_counts]
    counts = [grade_counts[g] for g in grades_present]
    colors = [GRADE_COLORS[g] for g in grades_present]
    bars = ax1.bar(grades_present, counts, color=colors, alpha=0.9, zorder=3)
    for bar, c in zip(bars, counts):
        ax1.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.05,
                 str(c), ha="center", color="white", fontweight="bold", fontsize=13)
    ax1.set_ylim(0, max(counts) + 1.5)
    ax1.set_title("Services by tosdr.org Grade", color="white",
                  fontsize=12, fontweight="bold")
    ax1.set_xlabel("Grade  (A = best, F = worst)", color="white", fontsize=10)
    ax1.set_ylabel("Number of Services", color="white", fontsize=10)
    ax1.tick_params(colors="white")
    ax1.spines[:].set_color("#444")
    ax1.grid(axis="y", color="#334", zorder=0)

    # Bar: avg DEEP recall per grade
    ax2.set_facecolor("#16213e")
    rec_vals = [avg_recall.get(g, 0) for g in grades_present]
    bars2 = ax2.bar(grades_present, rec_vals,
                    color=colors, alpha=0.9, zorder=3)
    for bar, v in zip(bars2, rec_vals):
        ax2.text(bar.get_x() + bar.get_width() / 2, v + 0.015,
                 f"{v:.0%}", ha="center", color="white",
                 fontweight="bold", fontsize=12)
    ax2.set_ylim(0, 1.15)
    ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
    ax2.set_title("Avg DEEP Recall by Grade", color="white",
                  fontsize=12, fontweight="bold")
    ax2.set_xlabel("Grade  (A = best, F = worst)", color="white", fontsize=10)
    ax2.set_ylabel("Avg Recall", color="white", fontsize=10)
    ax2.tick_params(colors="white")
    ax2.spines[:].set_color("#444")
    ax2.grid(axis="y", color="#334", zorder=0)

    fig.suptitle("Coverage Across tosdr.org Grade Spectrum",
                 color="white", fontsize=14, fontweight="bold", y=1.02)

    out = os.path.join(OUT_DIR, "chart4_grade_distribution.png")
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved: {out}")


# ---------------------------------------------------------------------------
# Chart 5: BASIC vs DEEP rating accuracy per service (pass/fail grid)
# ---------------------------------------------------------------------------

def chart5_accuracy_grid():
    fig, ax = plt.subplots(figsize=(14, 4))
    fig.patch.set_facecolor("#1a1a2e")
    ax.set_facecolor("#16213e")

    for i, name in enumerate(NAMES):
        basic_ok = BASIC_RAT[i] == EXPECTED[i]
        deep_ok  = DEEP_RAT[i]  == EXPECTED[i]

        ax.add_patch(plt.Rectangle(
            (i, 1), 1, 0.8,
            color="#2ecc71" if basic_ok else "#e74c3c", alpha=0.85
        ))
        ax.add_patch(plt.Rectangle(
            (i, 0), 1, 0.8,
            color="#2ecc71" if deep_ok else "#e74c3c", alpha=0.85
        ))

        ax.text(i + 0.5, 1.4, "✓" if basic_ok else "✗",
                ha="center", va="center", fontsize=14,
                color="white", fontweight="bold")
        ax.text(i + 0.5, 0.4, "✓" if deep_ok else "✗",
                ha="center", va="center", fontsize=14,
                color="white", fontweight="bold")

    ax.set_xlim(0, 25)
    ax.set_ylim(-0.4, 2.2)
    ax.set_xticks([i + 0.5 for i in range(25)])
    ax.set_xticklabels(NAMES, rotation=45, ha="right", color="white", fontsize=8)
    ax.set_yticks([0.4, 1.4])
    ax.set_yticklabels(["DEEP", "BASIC"], color="white", fontsize=11,
                       fontweight="bold")
    ax.set_title("Rating Accuracy per Service — BASIC vs DEEP  (green=correct, red=wrong)",
                 color="white", fontsize=12, fontweight="bold", pad=12)
    ax.tick_params(colors="white")
    ax.spines[:].set_color("#444")

    correct_patch = mpatches.Patch(color="#2ecc71", label="Correct rating")
    wrong_patch   = mpatches.Patch(color="#e74c3c", label="Wrong rating")
    ax.legend(handles=[correct_patch, wrong_patch],
              framealpha=0.2, labelcolor="white", fontsize=10,
              loc="upper right")

    out = os.path.join(OUT_DIR, "chart5_accuracy_grid.png")
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()
    print(f"  Saved: {out}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Generating TLDR Shield eval charts...")
    chart1_overall()
    chart2_per_service()
    chart3_error_breakdown()
    chart4_grade_distribution()
    chart5_accuracy_grid()
    print(f"\nAll charts saved to: {OUT_DIR}")
    print("Files:")
    for f in sorted(os.listdir(OUT_DIR)):
        print(f"  {f}")
