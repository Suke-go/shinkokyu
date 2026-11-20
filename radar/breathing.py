"""Breathing cycles from the radar's range-bin phases: when each breath happened, how long it took, how deep it was.

Steps (the usual ones for FMCW vital signs, e.g. Alizadeh et al., IEEE Access 2019; TI's vital signs lab):
  1. Chest velocity per range bin, from the phase step between frames summed over the antennas.
  2. Steps no breathing chest could make are clipped: they are phase jumps or the body shifting.
  3. Displacement, smoothed with a Gaussian (noise and heartbeat out) minus a wide Gaussian of itself
     (posture drift out). What is left is the breathing wave.
  4. The range bin whose wave repeats most regularly is taken as the chest, with the neighbours that move
     with it. The strongest reflection is often not the chest.
  5. The wave is cut into breaths at its upward zero crossings. A stretch in which the body itself was
     shifting is not counted as a breath.
"""
from collections import deque

import numpy as np

SMOOTH_S, BASE_S = 0.35, 2.5  # Gaussian sigmas
MIN_S, MAX_S = 1.7, 12.0  # a breath lasts this long: 5 to 35 a minute
JUMP_MM_S = 25.0  # a breathing chest stays under this
# ... and under this once smoothed over half a second: above it the body itself is shifting.
# A deep breath in (10 mm in 1.3 s) just stays below. Provisional until checked against paced breathing.
MOVE_MM_S = 12.0
MIN_DEPTH_MM = 0.3  # shallower than this is not a breath
SELECT_S = 30.0  # the chest is looked for in this much data
MIN_DB = 20  # bins reflecting less than this over the noise floor are not considered


def gauss(x, sigma_s, fs):
    k = int(4 * sigma_s * fs)
    g = np.exp(-0.5 * (np.arange(-k, k + 1) / (sigma_s * fs)) ** 2)
    return np.convolve(np.pad(x, k, mode="reflect"), g / g.sum(), mode="valid")


def breath_wave(vel, fs):
    """Chest velocity [mm/s] -> breathing wave [mm]."""
    s = gauss(np.cumsum(np.clip(vel, -JUMP_MM_S, JUMP_MM_S)) / fs, SMOOTH_S, fs)
    return s - gauss(s, BASE_S, fs)


def period_of(x, fs):
    """-> (period [s], regularity 0..1).

    Regularity is how far the autocorrelation swings between its dip at half a period and its peak at one
    period: 1 for a steady oscillation, about 0 for a slow wander. The first peak nearly as strong as the
    strongest is taken, so that two or three periods are not mistaken for one.
    """
    x = x - x.mean()
    n = len(x)
    ac = np.fft.irfft(np.abs(np.fft.rfft(x, 2 * n)) ** 2)[:n]
    ac = ac / (ac[0] + 1e-12) * n / (n - np.arange(n))
    lo, hi = int(MIN_S * fs), min(int(MAX_S * fs), n // 2)
    pk = np.flatnonzero((ac[lo + 1 : hi - 1] > ac[lo : hi - 2]) & (ac[lo + 1 : hi - 1] >= ac[lo + 2 : hi])) + lo + 1
    if not len(pk):
        return float("nan"), 0.0
    swing = np.array([(ac[k] - ac[:k].min()) / 2 for k in pk])
    i = np.flatnonzero(swing >= 0.85 * swing.max())[0]
    return pk[i] / fs, float(min(swing[i], 1.0))


def moving(vel, fs):
    """Chest velocity [mm/s] -> True where the body itself is shifting (posture, leaning, reaching)."""
    return gauss(np.abs(vel), 0.5, fs) > MOVE_MM_S


def cut_breaths(x, fs, shifting=None):
    """Breathing wave -> [(start index, end index, depth mm)], one per breath.

    A breath runs from one upward zero crossing to the next. In between, the wave must dip below a
    threshold (about a quarter of the size of the recent breathing, taken from the median so that one large
    movement does not raise it), so ripples around zero do not count. Stretches where `shifting` is
    True for more than a tenth of their length are dropped.
    """
    block, span = int(5 * fs), int(15 * fs)
    out, armed, start, lo, hi = [], False, None, 0.0, 0.0
    for b0 in range(0, len(x), block):
        h = max(0.35 * np.median(np.abs(x[max(b0 + block - span, 0) : b0 + block])), MIN_DEPTH_MM / 2)
        for i in range(max(b0, 1), min(b0 + block, len(x))):
            armed = armed or x[i] < -h
            lo, hi = min(lo, x[i]), max(hi, x[i])
            if armed and x[i - 1] <= 0 < x[i]:
                still = shifting is None or shifting[start:i].mean() <= 0.1 if start is not None else False
                if start is not None and MIN_S <= (i - start) / fs <= MAX_S and hi - lo >= MIN_DEPTH_MM and still:
                    out.append((start, i, hi - lo))
                start, armed, lo, hi = i, False, 0.0, 0.0
    return out


class Breathing:
    """Follows the chest from update to update and keeps one continuous breathing wave."""

    def __init__(self, fs, mm_per_rad, rng, rmin, rmax, keep_s=60.0):
        self.fs, self.mm, self.rng, self.rmin, self.rmax = fs, mm_per_rad, rng, rmin, rmax
        self.vel = deque(maxlen=int(keep_s * fs) if keep_s else None)  # chest velocity, one per frame
        self.chest = None  # range bin currently followed

    def reset(self):
        self.vel.clear()
        self.chest = None

    def update(self, H, n_new):
        """H: complex [time, bin, antenna], the latest frames (SELECT_S of them are used).
        n_new: how many of them arrived since the last update.
        -> br_* fields, the breaths that ended within SELECT_S as (seconds ago, period s, depth mm), and the wave."""
        fs = self.fs
        W = H[-int(SELECT_S * fs) :]
        amp = np.abs(W).mean(axis=(0, 2))
        db = 20 * np.log10(amp / np.percentile(amp[self.rng >= self.rmin], 20))
        cand = np.flatnonzero((self.rng >= self.rmin) & (self.rng <= self.rmax) & (db >= MIN_DB))
        n_new = min(n_new, len(W) - 1) if self.vel else len(W) - 1
        if not len(cand):
            self.vel.extend([0.0] * n_new)
            self.chest = None
            return {"br_period_s": None, "br_bpm": None, "br_q": 0.0, "br_depth_mm": 0.0, "br_range_m": None, "br_moving": 0.0, "breaths": [], "wave": np.zeros(1), "shifting": np.zeros(1, bool)}
        vel = np.angle((W[1:, cand] * W[:-1, cand].conj()).sum(axis=2)) * self.mm * fs
        waves = np.array([breath_wave(v, fs) for v in vel.T])
        regular = np.array([period_of(w, fs)[1] for w in waves])
        best = int(regular.argmax())
        if self.chest in cand:  # stay with the bin being followed unless another is clearly more regular
            prev = int(np.flatnonzero(cand == self.chest)[0])
            if regular[prev] >= 0.75 * regular[best]:
                best = prev
        self.chest = int(cand[best])
        with np.errstate(invalid="ignore", divide="ignore"):
            group = np.flatnonzero(np.nan_to_num([np.corrcoef(waves[best], w)[0, 1] for w in waves]) >= 0.6)
        if not len(group):
            group = np.array([best])
        self.vel.extend(vel[-n_new:, group].mean(axis=1))

        track = np.array(self.vel)
        x = breath_wave(track, fs)
        recent = int(SELECT_S * fs)
        period, q = period_of(x[-recent:], fs)
        shifting = moving(track, fs)
        breaths = [((len(x) - e) / fs, (e - s) / fs, d) for s, e, d in cut_breaths(x, fs, shifting) if e >= len(x) - recent]
        if len(breaths) >= 2:
            period = float(np.median([b[1] for b in breaths]))
        return {
            "br_period_s": None if np.isnan(period) else period,
            "br_bpm": None if np.isnan(period) else 60 / period,
            "br_q": q,
            "br_depth_mm": float(np.median([b[2] for b in breaths])) if breaths else float(np.ptp(x[-recent:])),
            "br_range_m": float(self.rng[cand[group]].mean()),
            "br_moving": float(shifting[-recent:].mean()),  # share of the time the body itself was shifting
            "breaths": breaths,
            "wave": x,
            "shifting": shifting,
        }
