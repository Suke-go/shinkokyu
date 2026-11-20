"""One picture and one line per radar session: what the radar saw and how the estimates behaved.

    python radar/report.py                       # every capture in radar/captures
    python radar/report.py path/to/radar_x.bin   # chosen captures, or folders of them

Writes <capture>.report.png next to each .bin. Works on captures from the app and from vitals.py,
whatever chirp they were recorded with (it reads the capture's own .json).
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.font_manager
import matplotlib.pyplot as plt
import numpy as np

from breathing import follow

N_ANT = 4
Q_MIN, SNR_MIN_DB, SPAN_MIN_MM = 0.35, 16, 0.3  # README: when an estimate is usable
RMAX_M = 1.5
_fonts = {f.name for f in matplotlib.font_manager.fontManager.ttflist}
plt.rcParams["font.family"] = [f for f in ("Yu Gothic", "Hiragino Sans", "Noto Sans CJK JP") if f in _fonts] + ["sans-serif"]
plt.rcParams["axes.spines.top"] = plt.rcParams["axes.spines.right"] = False


REPO = Path(__file__).parent.parent


def key_times(session_id, folder):
    """Times [ms, typing page's clock] of the keys pressed in a typing session: from the app's own copy
    next to the radar recording, else the local server's data folder, else Supabase. Empty if none has it."""
    local = next((f for f in (folder / f"typing_{session_id}.events.jsonl", REPO / "data" / f"{session_id}.events.jsonl") if f.exists()), None)
    try:
        if local:
            events = [json.loads(l) for l in local.read_text(encoding="utf-8").splitlines() if l.strip()]
        else:
            cfg = (REPO / "public/shared/config.js").read_text(encoding="utf-8")
            url, key = (re.search(rf"{k}:\s*'([^']*)'", cfg)[1] for k in ("url", "key"))
            events, last = [], -1
            while True:  # PostgREST returns at most 1000 rows a request
                q = f"{url.rstrip('/')}/rest/v1/events?session_id=eq.{session_id}&select=seq,ev&seq=gt.{last}&order=seq.asc&limit=1000"
                with urllib.request.urlopen(urllib.request.Request(q, headers={"apikey": key}), timeout=10) as r:
                    page = json.load(r)
                if not page:
                    break
                events += [x["ev"] for x in page]
                last = page[-1]["seq"]
    except (OSError, ValueError, TypeError) as e:
        print(f"  (typing events of {session_id} not available: {e!r})")
        return np.array([])
    return np.array([e["t"] for e in events if e.get("type") == "keydown" and not e.get("repeat")])


def load(bin_path):
    meta = json.loads(bin_path.with_suffix(".json").read_text(encoding="utf-8"))
    n_bins = int(next(l for l in meta["config"] if l.startswith("profileCfg")).split()[10])
    rec = np.fromfile(bin_path, dtype=np.dtype([("t", "<f8"), ("fnum", "<u4"), ("iq", "<i2", (n_bins, N_ANT, 2))]))
    step = np.diff(rec["fnum"].astype(np.int64))
    k = np.concatenate([[0], np.cumsum(np.where(step > 0, step, 1))])  # frame index; a sensor restart counts as 1 frame
    H = np.zeros((k[-1] + 1, n_bins, N_ANT), np.complex64)
    H[:] = np.nan
    H[k] = rec["iq"][..., 1] + 1j * rec["iq"][..., 0]
    rows = [json.loads(l) for l in bin_path.with_suffix("").with_suffix(".hr.jsonl").read_text().splitlines() if l.strip()]
    for r in rows:
        r["s"] = (r["t"] - rec["t"][0]) / 1000
    # a recording made during a typing task is on the typing page's clock, the same clock as the key events
    meta["keys_s"] = (key_times(meta["sessionId"], bin_path.parent) - rec["t"][0]) / 1000 if meta.get("sessionId") else np.array([])
    # chest strap logged alongside (strap.py): its mean rate over the same 20 s as each estimate
    rr_path = bin_path.with_suffix("").with_suffix(".rr.jsonl")
    notes = [json.loads(l) for l in rr_path.read_text().splitlines()] if rr_path.exists() else []
    for r in rows:
        inside = [n for n in notes if r["t"] - r["window"] * 1000 < n["t"] <= r["t"]]
        rr = [x for n in inside for x in n["rr"]]
        # a wristband that broadcasts its rate sends no intervals: use the rate it reports
        r["strap_bpm"] = 60000 / np.mean(rr) if len(rr) >= 10 else float(np.mean([n["hr"] for n in inside])) if len(inside) >= 5 else None
    return meta, rec, H, rows


def summarize(meta, rec, H, rows):
    fps, mm = meta["frameHz"], meta["wavelengthM"] / (4 * np.pi) * 1e3
    rng = np.arange(H.shape[1]) * meta["rangeResM"]
    amp = np.abs(H).mean(axis=2)  # [time, bin]
    with np.errstate(invalid="ignore"):
        step = np.angle((H[1:] * H[:-1].conj()).sum(axis=2))  # phase step per bin
    speed = np.abs(step) * mm * fps  # mm/s, saturates at the alias limit
    near = (rng >= 0.3) & (rng <= RMAX_M)
    strongest = np.nanmean(amp, axis=0) * near
    body = int(strongest.argmax())
    lo, hi = max(body - 1, 0), body + 2
    # the body's own bins, power-weighted: the same quantity the estimator works from
    with np.errstate(invalid="ignore"):
        dphi = np.angle((H[1:, lo:hi] * H[:-1, lo:hi].conj()).sum(axis=(1, 2)))
    win = int(20 * fps)
    for r in rows:
        if "snr_db" not in r:  # captures from before the estimator logged it
            e = min(int(r["s"] * fps), len(H))
            a = np.nanmean(amp[max(e - win, 0) : e], axis=0)
            r["snr_db"] = 20 * np.log10(a[near].max() / np.percentile(a[rng >= 0.3], 20))
        r["seen"] = r["snr_db"] >= SNR_MIN_DB and (r["span_mm"] or 0) >= SPAN_MIN_MM  # a person: strong and breathing
        r["usable"] = r["seen"] and (r["hr_q"] or 0) >= Q_MIN
    ok = [r for r in rows if r["usable"]]
    hr = np.array([r["hr_bpm"] for r in ok])
    gaps = np.diff(rec["t"])
    # the breathing wave over the whole session, followed the way the live estimator follows it
    wave, shifting, cut = follow(np.nan_to_num(H), fps, mm, rng, 0.3, RMAX_M)
    breaths = [(e / fps, period, d) for _, e, period, d in cut]  # (end s, period s, depth mm)
    periods = np.array([b[1] for b in breaths])
    # typing: a frame counts as "typing" if a key was pressed in the 2 s up to it
    keys = meta["keys_s"]
    tf = (np.arange(len(shifting)) + 1) / fps
    typing = (np.searchsorted(keys, tf) - np.searchsorted(keys, tf - 2)) > 0 if len(keys) else np.zeros(len(tf), bool)
    in_typing = lambda t: bool(typing[min(int(t * fps), len(typing) - 1)]) if len(typing) else False
    per_min = lambda n, mask: 60 * n / (mask.sum() / fps) if mask.sum() else float("nan")
    return {
        "keys": keys, "n_keys": len(keys), "typing_share": float(typing.mean()) if len(keys) else float("nan"),
        "moved_typing": float(shifting[typing].mean()) if typing.any() else float("nan"),
        "moved_idle": float(shifting[~typing].mean()) if (~typing).any() else float("nan"),
        "br_typing": per_min(sum(in_typing(b[0]) for b in breaths), typing),
        "br_idle": per_min(sum(not in_typing(b[0]) for b in breaths), ~typing),
        "wave": wave, "shifting": shifting, "breaths": breaths, "shift_share": float(shifting.mean()),
        "br_n": len(breaths),
        "br_period": float(np.median(periods)) if len(periods) else float("nan"),
        "br_iqr": float(np.subtract(*np.percentile(periods, [75, 25]))) if len(periods) > 1 else float("nan"),
        "br_depth": float(np.median([b[2] for b in breaths])) if breaths else float("nan"),
        "fps": fps, "mm": mm, "rng": rng, "amp": amp, "speed": speed, "body": body,
        "alias": meta["wavelengthM"] / 4 * fps * 1e3,
        "seconds": len(H) / fps,
        "dropped": int(np.isnan(H[:, 0, 0]).sum()),
        "link_gaps": int((gaps > 500).sum()),
        "body_m": rng[body],
        "fast": float(np.nanmean(np.abs(dphi) > np.pi / 2)),  # more than half the alias limit
        "still": float(np.nanmean(np.abs(dphi) * mm * fps < 5)),
        "seen": float(np.mean([r["seen"] for r in rows])) if rows else float("nan"),
        "usable": len(ok) / len(rows) if rows else float("nan"),
        "hr_median": float(np.median(hr)) if len(hr) else float("nan"),
        "hr_spread": float(np.subtract(*np.percentile(hr, [90, 10]))) if len(hr) > 1 else float("nan"),
        "span": float(np.median([r["span_mm"] for r in rows])) if rows else float("nan"),
        # mean absolute difference from the strap, over the usable estimates
        "err": float(np.mean([abs(r["hr_bpm"] - r["strap_bpm"]) for r in ok if r["strap_bpm"]])) if any(r["strap_bpm"] for r in ok) else float("nan"),
    }


def figure(name, s, rows, out):
    t_max = s["seconds"]
    keep = s["rng"] <= RMAX_M
    extent = [0, t_max, 0, s["rng"][keep][-1] + s["rng"][1]]
    block = max(int(s["fps"] / 4), 1)  # 0.25 s per pixel column

    def blocks(a):
        n = len(a) // block * block
        with np.errstate(all="ignore"):
            return np.nanmean(a[:n].reshape(-1, block, a.shape[1]), axis=1).T

    amp = blocks(s["amp"][:, keep])
    db = 20 * np.log10(np.maximum(amp, 1))
    speed = blocks(s["speed"][:, keep])
    speed[db[:, : speed.shape[1]] < np.nanmax(db) - 25] = np.nan  # nothing reflects there: no phase to speak of

    typed = len(s["keys"]) > 0
    fig, ax = plt.subplots(5 + typed, 1, figsize=(11, 12.5 + 1.4 * typed), sharex=True, gridspec_kw={"height_ratios": [3, 3, 2.2, 1.8, 1.8] + [1.1] * typed}, constrained_layout=True)
    pc = lambda x: "–" if np.isnan(x) else f"{x * 100:.0f}%"
    fig.suptitle(
        f"{name}    {t_max:.0f} 秒 / 毎秒 {s['fps']:g} フレーム / 欠落 {s['dropped']} / USB 切断 {s['link_gaps']} 回\n"
        f"いちばん強い反射 {s['body_m']:.2f} m    静止 {pc(s['still'])}    速い動き {pc(s['fast'])}    人が映っていた {pc(s['seen'])}    呼吸 {s['br_n']} 回（中央値 {s['br_period']:.1f} 秒）    使える心拍の推定 {pc(s['usable'])}",
        fontsize=11, x=0.01, ha="left")

    im = ax[0].imshow(db, origin="lower", aspect="auto", extent=extent, cmap="Greys", vmin=np.nanmax(db) - 30, vmax=np.nanmax(db))
    ax[0].set(ylabel="距離 [m]", title="反射の強さ：どの距離に物があるか")
    fig.colorbar(im, ax=ax[0], label="dB", pad=0.01)
    if rows:
        ax[0].plot([r["s"] for r in rows], [r["range_m"] for r in rows], color="#C2410C", lw=1.5, label="推定が見ていた距離")
        ax[0].legend(loc="upper right", frameon=False, fontsize=9)

    im = ax[1].imshow(speed, origin="lower", aspect="auto", extent=extent, cmap="Blues", vmin=0, vmax=s["alias"])
    ax[1].set(ylabel="距離 [m]", title=f"動きの速さ：その距離の物がどれだけ動いているか（{s['alias']:.0f} mm/s で頭打ち）")
    fig.colorbar(im, ax=ax[1], label="mm/s", pad=0.01)

    tw = (np.arange(len(s["wave"])) + 1) / s["fps"]
    ax[2].plot(tw, s["wave"], color="#1F2328", lw=1.2)
    ax[2].axhline(0, color="#D8DEE4", lw=0.8)
    ax[2].fill_between(tw, -1e3, 1e3, where=s["shifting"], color="#FCEBDD", lw=0, label="体が動いている（呼吸として数えない）")
    for end, period, _ in s["breaths"]:
        ax[2].axvline(end, color="#C2410C", lw=0.7)
        ax[2].axvline(end - period, color="#C2410C", lw=0.7)
    ax[2].legend(loc="upper right", frameon=False, fontsize=9)
    lim = max(np.percentile(np.abs(s["wave"]), 99.5) * 1.3, 1) if len(s["wave"]) > 1 else 1
    ax[2].set(ylabel="mm", ylim=(-lim, lim), title="呼吸の波形（胸の変位。縦線 = 1 呼吸の区切り）")

    ax[3].scatter([b[0] for b in s["breaths"]], [b[1] for b in s["breaths"]], s=[10 + 12 * b[2] for b in s["breaths"]], color="#1F2328")
    ax[3].set(ylabel="秒", ylim=(0, 13), title="1 呼吸ごとの長さ（点の大きさ = 深さ）")
    ax[3].grid(axis="y", color="#E8ECF0")

    good = [r for r in rows if r["usable"]]
    bad = [r for r in rows if not r["usable"]]
    # grey band: no person was in the beam for the 20 s behind these estimates
    step = np.median(np.diff([r["s"] for r in rows])) if len(rows) > 1 else 2
    for a in ax[2:]:
        for i, r in enumerate(r for r in rows if not r["seen"]):
            a.axvspan(r["s"] - step / 2, r["s"] + step / 2, color="#EEF0F3", lw=0, label="人が映っていない" if i == 0 and a is ax[4] else None)
    ax[4].scatter([r["s"] for r in bad], [r["hr_bpm"] for r in bad], s=28, facecolors="none", edgecolors="#8C959F", label="使えない推定")
    ax[4].scatter([r["s"] for r in good], [r["hr_bpm"] for r in good], s=28, color="#1F2328", label="使える推定")
    if any(r["strap_bpm"] for r in rows):
        ax[4].plot([r["s"] for r in rows if r["strap_bpm"]], [r["strap_bpm"] for r in rows if r["strap_bpm"]], color="#C2410C", lw=1.5, label="胸ストラップ")
    ax[4].set(ylabel="毎分", ylim=(30, 160), xlim=(0, t_max), title="心拍数。各点は直前 20 秒についての値")
    if typed:
        ax[5].hist(s["keys"], bins=np.arange(0, t_max + 1), color="#8C959F")
        ax[5].set(ylabel="キー/秒", title="打鍵")
    ax[-1].set_xlabel("開始からの時間 [秒]")
    ax[4].legend(loc="upper right", frameon=False, fontsize=9, ncols=4)
    ax[4].grid(axis="y", color="#E8ECF0")
    fig.savefig(out, dpi=110)
    plt.close(fig)


def main():
    args = [Path(a) for a in sys.argv[1:]] or [Path(__file__).parent / "captures"]
    bins = sorted(b for a in args for b in ([a] if a.suffix == ".bin" else a.glob("*.bin")))
    print(f"{'session':40s} {'sec':>4s} {'fps':>3s} {'drop':>4s} {'usb':>3s} {'body m':>6s} {'still':>5s} {'fast':>5s} {'seen':>5s} {'breaths':>7s} {'period':>6s} {'iqr':>4s} {'depth':>5s} {'moved':>5s} {'HR ok':>5s} {'HR':>4s} {'vs strap':>8s}")
    for b in bins:
        if b.stat().st_size < 400_000:  # about 10 s of frames: the tracker has nothing to go by before that
            print(f"{b.stem:40s} {'empty (no frame arrived)' if b.stat().st_size == 0 else 'too short (under 10 s)'}")
            continue
        meta, rec, H, rows = load(b)
        s = summarize(meta, rec, H, rows)
        figure(b.stem, s, rows, b.with_suffix(".report.png"))
        pct = lambda x: f"{x * 100:.0f}%"
        print(f"{b.stem:40s} {s['seconds']:4.0f} {s['fps']:3g} {s['dropped']:4d} {s['link_gaps']:3d} {s['body_m']:6.2f} {pct(s['still']):>5s} {pct(s['fast']):>5s} "
              f"{pct(s['seen']) if rows else '-':>5s} {s['br_n']:7d} {s['br_period']:6.1f} {s['br_iqr']:4.1f} {s['br_depth']:5.1f} {pct(s['shift_share']):>5s} {pct(s['usable']) if rows else '-':>5s} {s['hr_median']:4.0f} {s['err']:8.1f}")
        if s["n_keys"]:
            print(f"  typing: {s['n_keys']} keys, typing {pct(s['typing_share'])} of the time | body shifting {pct(s['moved_typing'])} while typing, {pct(s['moved_idle'])} while not"
                  f" | breaths counted per minute: {s['br_typing']:.1f} while typing, {s['br_idle']:.1f} while not")


if __name__ == "__main__":
    main()
