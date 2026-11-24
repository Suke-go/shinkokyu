"""Analysis tables from the app's records: one row per session, one row per breath.

    python radar/export.py                 # the app's folder (Documents/shinkokyu-radar)
    python radar/export.py <folder>        # a folder copied from another PC

Writes <folder>/export/sessions.csv and breaths.csv (UTF-8 with BOM, opens in Excel). Breaths are worked out
again from the raw radar frames with the current method, not taken from what the app showed at the time,
so every session in a table was treated the same way.

Times: `t_s` is seconds from the start of typing (negative during the resting measurement); `utc` is
filled when the session was synced to a server clock.

The resting measurement of a session is the one timed with the stopwatch on the app's first screen
(rest_<stamp>.json): the last that ended before the session started, at most an hour earlier. Sessions
recorded when the task itself timed the rest carry it in their own events (baseline_start, baseline_end).
"""
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from breathing import follow
from report import N_ANT, RMAX_M

SESSION_COLUMNS = [
    "session_id", "exp_id", "participant_id", "started_utc", "synced",
    "rest_s", "rest_skipped", "rest_breaths", "rest_period_s", "rest_period_iqr_s", "rest_depth_mm", "rest_counted", "rest_moved",
    "task_s", "task_breaths", "task_period_s", "task_period_iqr_s", "task_depth_mm", "task_counted", "task_moved",
    "keys", "final_chars", "source_chars", "finished", "radar_frames_dropped",
]
BREATH_COLUMNS = ["session_id", "participant_id", "phase", "t_s", "utc", "period_s", "depth_mm"]


def to_utc(syncs):
    """Local ms -> UTC ms from the session's clock syncs (as public/shared/clock.js makeOffsetFn); None if unsynced."""
    last = lambda phase: next((s for s in reversed(syncs) if s.get("phase") == phase and isinstance(s.get("offset"), (int, float))), None)
    a, b = last("start"), last("end")
    if a and b and a["at"] != b["at"]:
        return lambda t: t + a["offset"] + (b["offset"] - a["offset"]) / (b["at"] - a["at"]) * (t - a["at"])
    return (lambda t: t + (a or b)["offset"]) if a or b else None


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds") if ms is not None else ""


def phase_stats(breaths, shifting_share, seconds):
    periods = np.array([b["period_s"] for b in breaths])
    return {
        "s": round(seconds, 1), "breaths": len(breaths),
        "period_s": round(float(np.median(periods)), 2) if len(periods) else "",
        "period_iqr_s": round(float(np.subtract(*np.percentile(periods, [75, 25]))), 2) if len(periods) > 1 else "",
        "depth_mm": round(float(np.median([b["depth_mm"] for b in breaths])), 2) if breaths else "",
        "counted": round(float(periods.sum()) / seconds, 3) if seconds else "",  # share of the time inside a counted breath
        "moved": round(shifting_share, 3) if shifting_share is not None else "",
    }


def track(radar_bin):
    """One radar recording -> (breaths [{t ms on the recording's clock, period_s, depth_mm}], time of each track
    sample, body-shifting mask, frames dropped)."""
    rm = json.loads(radar_bin.with_suffix(".json").read_text(encoding="utf-8"))
    n_bins = int(next(l for l in rm["config"] if l.startswith("profileCfg")).split()[10])
    rec = np.fromfile(radar_bin, dtype=np.dtype([("t", "<f8"), ("fnum", "<u4"), ("iq", "<i2", (n_bins, N_ANT, 2))]))
    fps = rm["frameHz"]
    H = rec["iq"][..., 1] + 1j * rec["iq"][..., 0]  # frames as recorded: a dropped one shortens the track by 1/fps
    wave, shifting, cut = follow(H, fps, rm["wavelengthM"] / (4 * np.pi) * 1e3, np.arange(n_bins) * rm["rangeResM"], 0.3, RMAX_M)
    frame_t = rec["t"][1:]  # the track has one sample per frame step
    breaths = [{"t": float(frame_t[min(end, len(frame_t) - 1)]), "period_s": period, "depth_mm": depth} for _, end, period, depth in cut]
    return breaths, frame_t[: len(shifting)], shifting, int(rec["fnum"][-1] - rec["fnum"][0] + 1 - len(rec))


def rest_before(folder, start_ms):
    """The stopwatch-timed resting measurement that belongs to a session starting at `start_ms` (this PC's clock)
    -> (its record, the radar recording made meanwhile), None where there is none."""
    rests = [json.loads(f.read_text(encoding="utf-8")) for f in folder.glob("rest_*.json")]
    mine = max((r for r in rests if 0 <= start_ms - r["t1"] <= 3600_000), key=lambda r: r["t1"], default=None)
    if mine:
        for b in folder.glob("radar_*.bin"):
            if b.stat().st_size and not (folder / f"typing_{b.stem[len('radar_'):]}.json").exists():
                step = 12 + int(next(l for l in json.loads(b.with_suffix(".json").read_text(encoding="utf-8"))["config"] if l.startswith("profileCfg")).split()[10]) * N_ANT * 4
                with open(b, "rb") as fh:  # first and last frame time, without reading the recording
                    first = np.frombuffer(fh.read(8), "<f8")[0]
                    fh.seek(b.stat().st_size // step * step - step)
                    last = np.frombuffer(fh.read(8), "<f8")[0]
                if first <= mine["t0"] and mine["t1"] <= last + 2000:
                    return mine, b
    return mine, None


def session(folder, sid):
    """-> (row for sessions.csv, rows for breaths.csv) of one typing session."""
    meta = json.loads((folder / f"typing_{sid}.json").read_text(encoding="utf-8"))
    events = [json.loads(l) for l in (folder / f"typing_{sid}.events.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    at = lambda kind: next((e["t"] for e in events if e["type"] == kind), None)
    rest0, rest1, task0, task1 = at("baseline_start"), at("baseline_end"), at("session_start"), at("session_end")
    rest_end = next((json.loads(e["data"]) for e in events if e["type"] == "baseline_end"), {})
    last_t = max(e["t"] for e in events)
    utc = to_utc(meta.get("syncs") or [])

    breaths, moved, dropped = [], {}, ""
    share = lambda t, shifting, a, b: float(shifting[(t >= a) & (t < b)].mean()) if a is not None and b is not None and ((t >= a) & (t < b)).any() else None
    radar_meta, radar_bin = folder / f"radar_{sid}.json", folder / f"radar_{sid}.bin"
    offset = 0.0  # the typing page's clock minus this PC's clock
    if radar_bin.exists() and radar_bin.stat().st_size:
        offset = json.loads(radar_meta.read_text(encoding="utf-8")).get("clockOffsetMs") or 0.0
        breaths, frame_t, shifting, dropped = track(radar_bin)  # same clock as the typing events
        moved = {"rest": share(frame_t, shifting, rest0, rest1), "task": share(frame_t, shifting, task0, task1 or last_t)}
    if rest0 is None and task0 is not None:  # the rest was timed with the stopwatch before the task was opened
        timed, timed_bin = rest_before(folder, task0 - offset)
        if timed:
            rest0, rest1 = timed["t0"] + offset, timed["t1"] + offset  # onto the typing page's clock
            rest_end = {"skipped": timed["seconds"] < timed["planned"]}
        if timed_bin:
            b, frame_t, shifting, _ = track(timed_bin)
            breaths = [dict(x, t=x["t"] + offset) for x in b] + breaths
            moved["rest"] = share(frame_t + offset, shifting, rest0, rest1)

    def phase_of(t):
        if rest0 is not None and rest1 is not None and rest0 <= t < rest1:
            return "rest"
        return "task" if task0 is not None and task0 <= t <= (task1 or last_t) else ""

    for b in breaths:
        b["phase"] = phase_of(b["t"])
    rest = phase_stats([b for b in breaths if b["phase"] == "rest"], moved.get("rest"), (rest1 - rest0) / 1000 if rest0 is not None and rest1 is not None else 0)
    task = phase_stats([b for b in breaths if b["phase"] == "task"], moved.get("task"), ((task1 or last_t) - task0) / 1000 if task0 is not None else 0)
    row = {
        "session_id": sid, "exp_id": meta.get("expId", ""), "participant_id": meta.get("participantId", ""),
        "started_utc": iso(utc(task0)) if utc and task0 is not None else "", "synced": bool(utc),
        "rest_skipped": rest_end.get("skipped", ""),
        **{f"rest_{k}": v for k, v in rest.items()}, **{f"task_{k}": v for k, v in task.items()},
        "keys": sum(e["type"] == "keydown" and not e.get("repeat") for e in events),
        "final_chars": len(meta.get("finalText") or ""), "source_chars": len(meta.get("sourceText") or ""),
        "finished": meta.get("endedAt") is not None, "radar_frames_dropped": dropped,
    }
    breath_rows = [{
        "session_id": sid, "participant_id": meta.get("participantId", ""), "phase": b["phase"],
        "t_s": round((b["t"] - task0) / 1000, 2) if task0 is not None else "", "utc": iso(utc(b["t"])) if utc else "",
        "period_s": round(b["period_s"], 2), "depth_mm": round(b["depth_mm"], 2),
    } for b in breaths if b["phase"]]
    return row, breath_rows


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Documents" / "shinkokyu-radar"
    sessions, breaths = [], []
    for f in sorted(folder.glob("typing_*.events.jsonl")):
        sid = f.name[len("typing_") : -len(".events.jsonl")]
        try:
            row, rows = session(folder, sid)
        except (OSError, ValueError, KeyError, StopIteration) as e:  # one unreadable session must not stop the rest
            print(f"skipped {sid}: {e!r}")
            continue
        sessions.append(row)
        breaths += rows
        print(f"{sid}: rest {row['rest_breaths']} breaths ({row['rest_period_s']} s), task {row['task_breaths']} breaths ({row['task_period_s']} s), {row['keys']} keys")
    out = folder / "export"
    out.mkdir(exist_ok=True)
    for name, columns, rows in (("sessions.csv", SESSION_COLUMNS, sessions), ("breaths.csv", BREATH_COLUMNS, breaths)):
        with open(out / name, "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.DictWriter(fh, fieldnames=columns)
            w.writeheader()
            w.writerows(rows)
    print(f"{len(sessions)} sessions, {len(breaths)} breaths -> {out}")


if __name__ == "__main__":
    main()
