"""Breathing cycles and heart rate from one track of the chest's motion.

The chest's displacement is split by time scale: what a wide Gaussian follows is posture, what a narrow
Gaussian follows on top of that is breathing, and what is left over holds the heartbeat.

Steps (the usual ones for FMCW vital signs, e.g. Alizadeh et al., IEEE Access 2019; TI's vital signs lab):
  0. A static reflection sharing the bin (a chair back when measuring from behind, clothing, a desk edge) is
     subtracted where it is stronger than the moving one: left in, it shrinks and bends the phase swing.
  1. Chest velocity per range bin, from the phase step between frames summed over the antennas.
  2. Steps no breathing chest could make are clipped: they are phase jumps or the body shifting.
  3. Displacement, smoothed with a Gaussian (noise and heartbeat out) minus a wide Gaussian of itself
     (posture drift out). What is left is the breathing wave.
  4. The range bin whose wave repeats most regularly is taken as the chest, with the neighbours that move
     with it. The strongest reflection is often not the chest.
  5. The wave is cut into breaths at its upward zero crossings. A stretch in which the body itself was
     shifting is not counted as a breath.
  6. Heart rate, after breathing and never against it: the spectrum of what the breathing smoother left
     over (as velocity), scored together with its second harmonic. A peak near the previous estimate is
     preferred if it is at least half as strong as the strongest: a heart rate does not jump 20 beats in 2 s.
     A peak on the 2nd to 5th multiple of the measured breathing rate is kept only if the heart rate was
     already there; otherwise there is no heart rate for that moment, rather than a guess.
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
# The chest is looked for among the bins that reflect at least this much over the noise floor (an empty beam
# shows 7-13 dB, a back 19-29, a chest 28-39) and lie within BODY_M of the strongest reflection: a weak bin far
# from the body is noise, however regularly it happens to move.
MIN_DB = 16
BODY_M = 0.25
HEART_S = 20.0  # heart rate is estimated over this much of the track
HEART_HZ = (0.8, 2.5)  # 48 to 150 beats a minute


def remove_static(z):
    """z: complex samples of one range bin on one antenna. A moving reflector draws an arc around whatever
    static reflection shares the bin; the arc's centre is that static part (least-squares circle fit).
    It is subtracted only if the fit is a real arc and the static part is the stronger one."""
    m = z.mean()
    x, y = (z - m).real, (z - m).imag
    sol, *_ = np.linalg.lstsq(np.c_[2 * x, 2 * y, np.ones(len(z))], x * x + y * y, rcond=None)
    c = sol[0] + 1j * sol[1]
    r = np.sqrt(max(sol[2] + abs(c) ** 2, 0.0))
    arc = r > 0 and np.sqrt(np.mean((np.abs(z - m - c) - r) ** 2)) < 0.3 * r
    return z - (m + c) if arc and abs(m + c) > r else z


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

    A breath runs from one upward zero crossing to the next. In between, the wave must first rise above a
    threshold and then dip below minus that threshold (about a quarter of the size of the recent
    breathing, taken from the median so that one large movement does not raise it). Ripples around zero
    lack one or the other and do not end a breath: the pause after a slow deep breath out is such a ripple.
    Stretches where `shifting` is True for more than a tenth of their length are dropped.
    """
    block, span = int(5 * fs), int(15 * fs)
    out, armed, start, lo, hi = [], False, None, 0.0, 0.0
    for b0 in range(0, len(x), block):
        h = max(0.35 * np.median(np.abs(x[max(b0 + block - span, 0) : b0 + block])), MIN_DEPTH_MM / 2)
        for i in range(max(b0, 1), min(b0 + block, len(x))):
            lo, hi = min(lo, x[i]), max(hi, x[i])
            armed = armed or (x[i] < -h and (hi > h or start is None))  # the first breath has no known start
            if armed and x[i - 1] <= 0 < x[i]:
                still = shifting is None or shifting[start:i].mean() <= 0.1 if start is not None else False
                if start is not None and MIN_S <= (i - start) / fs <= MAX_S and hi - lo >= MIN_DEPTH_MM and still:
                    out.append((start, i, hi - lo))
                start, armed, lo, hi = i, False, 0.0, 0.0
    return out


def heart_rate(vel, fs, prev=None, breath_s=None):
    """Chest velocity [mm/s] -> (beats/min, share of the band's power within 0.1 Hz of that peak,
    beats/min of the strongest peak before `prev` and the breathing harmonics were taken into account).
    breath_s: the measured length of a breath. A peak on its 2nd-5th harmonic counts as a heart rate only
    if the heart rate was already there (within 5 of `prev`): a breathing harmonic moves with the breathing,
    a heart rate stays. Otherwise a weaker peak is taken only if it is off the harmonics and near `prev`.
    The first two are None when that leaves nothing: the moment belongs to breathing."""
    d = np.cumsum(np.clip(vel, -JUMP_MM_S, JUMP_MM_S)) / fs
    x = np.gradient(d - gauss(d, SMOOTH_S, fs)) * fs
    n = len(x)
    i = np.arange(n)
    x = x - np.polyval(np.polyfit(i, x, 1), i)
    nfft = 1 << int(np.ceil(np.log2(n * 8)))
    f = np.fft.rfftfreq(nfft, 1 / fs)
    s = np.abs(np.fft.rfft(x * np.hanning(n), nfft)) ** 2
    band = np.flatnonzero((f >= HEART_HZ[0]) & (f <= HEART_HZ[1]))
    score = s[band] + s[2 * band]
    pk = np.flatnonzero((score > np.r_[score[1:], 0]) & (score >= np.r_[0, score[:-1]]))
    if not len(pk):
        pk = np.array([score.argmax()])
    top = int(pk[score[pk].argmax()])
    fb = f[band]
    bpm = fb * 60
    on_harmonic = lambda j: bool(breath_s) and any(abs(fb[j] - h / breath_s) < 0.05 for h in range(2, 6))
    k = top
    if prev is not None:
        near = [j for j in pk if abs(bpm[j] - prev) <= 10 and score[j] >= 0.5 * score[top]]
        if near:
            k = int(max(near, key=lambda j: score[j]))
    if on_harmonic(k) and (prev is None or abs(bpm[k] - prev) > 5):
        # a tenth of the strongest peak: less than that is only its skirt
        free = [j for j in pk if prev is not None and abs(bpm[j] - prev) <= 10 and score[j] >= 0.1 * score[top] and not on_harmonic(j)]
        if not free:
            return None, None, float(bpm[top])
        k = int(max(free, key=lambda j: score[j]))
    return float(fb[k] * 60), float(s[band][np.abs(fb - fb[k]) <= 0.1].sum() / s[band].sum()), float(fb[top] * 60)


def follow(H, fs, mm_per_rad, rng, rmin, rmax):
    """A whole recording, followed the way the live estimator follows it.
    H: complex [time, bin, antenna]. -> (breathing wave mm, body-shifting mask, [(start, end, period s, depth mm)]),
    one wave sample per frame step; start and end index into it."""
    tracker = Breathing(fs, mm_per_rad, rng, rmin, rmax, keep_s=None)
    hop, look = int(2 * fs), int(SELECT_S * fs)
    wave, shifting = np.zeros(1), np.zeros(1, bool)
    for end in range(min(int(10 * fs), len(H)), len(H) + 1, hop):
        r = tracker.update(H[max(end - look, 0) : end], hop)
        wave, shifting = r["wave"], r["shifting"]
    return wave, shifting, [(a, e, (e - a) / fs, d) for a, e, d in cut_breaths(wave, fs, shifting)]


class Breathing:
    """Follows the chest from update to update and keeps one continuous breathing wave."""

    def __init__(self, fs, mm_per_rad, rng, rmin, rmax, keep_s=60.0):
        self.fs, self.mm, self.rng, self.rmin, self.rmax = fs, mm_per_rad, rng, rmin, rmax
        self.vel = deque(maxlen=int(keep_s * fs) if keep_s else None)  # chest velocity, one per frame
        self.chest = None  # range bin currently followed
        self.hr = None  # last heart rate, for continuity

    def reset(self):
        self.vel.clear()
        self.chest = self.hr = None

    def update(self, H, n_new):
        """H: complex [time, bin, antenna], the latest frames (SELECT_S of them are used).
        n_new: how many of them arrived since the last update.
        -> br_* fields, the breaths that ended within SELECT_S as (seconds ago, period s, depth mm), and the wave."""
        fs = self.fs
        W = H[-int(SELECT_S * fs) :]
        amp = np.abs(W).mean(axis=(0, 2))
        db = 20 * np.log10(amp / np.percentile(amp[self.rng >= self.rmin], 20))
        near = (self.rng >= self.rmin) & (self.rng <= self.rmax)
        body = self.rng[int(np.argmax(np.where(near, db, -np.inf)))]
        cand = np.flatnonzero(near & (db >= MIN_DB) & (np.abs(self.rng - body) <= BODY_M))
        n_new = min(n_new, len(W) - 1) if self.vel else len(W) - 1
        if not len(cand):
            self.vel.extend([0.0] * n_new)
            self.chest = self.hr = None
            return {"hr_bpm": None, "hr_q": 0.0, "hr_peak_bpm": None, "br_period_s": None, "br_bpm": None, "br_q": 0.0, "br_depth_mm": 0.0, "br_range_m": None, "br_span_mm": 0.0, "br_moving": 0.0, "br_moving_now": 0.0, "breaths": [], "wave": np.zeros(1), "shifting": np.zeros(1, bool)}
        W = np.stack([np.stack([remove_static(W[:, c, a]) for a in range(W.shape[2])], axis=1) for c in cand], axis=1)
        vel = np.angle((W[1:] * W[:-1].conj()).sum(axis=2)) * self.mm * fs
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
        self.bins = cand[group]  # range bins taken as the chest
        self.vel.extend(vel[-n_new:, group].mean(axis=1))

        track = np.array(self.vel)
        x = breath_wave(track, fs)
        recent = int(SELECT_S * fs)
        period, q = period_of(x[-recent:], fs)
        shifting = moving(track, fs)
        breaths = [((len(x) - e) / fs, (e - s) / fs, d) for s, e, d in cut_breaths(x, fs, shifting) if e >= len(x) - recent]
        if len(breaths) >= 2:
            period = float(np.median([b[1] for b in breaths]))
        # breathing first: its harmonics are excluded from the heart rate only when the breathing itself is trusted
        trusted = len(breaths) >= 2 and q >= 0.3
        hr, hr_q, hr_peak = heart_rate(track[-int(HEART_S * fs) :], fs, self.hr, period if trusted else None)
        self.hr = hr if hr is not None else self.hr
        return {
            "hr_bpm": hr,  # None: everything in the heart band sat on a breathing harmonic
            "hr_q": hr_q or 0.0,
            "hr_peak_bpm": hr_peak,  # the strongest peak as found; differs from hr_bpm when it was a breathing harmonic or far from the last value
            "br_period_s": None if np.isnan(period) else period,
            "br_bpm": None if np.isnan(period) else 60 / period,
            "br_q": q,
            "br_depth_mm": float(np.median([b[2] for b in breaths])) if breaths else float(np.ptp(x[-recent:])),
            "br_span_mm": float(2 * np.percentile(np.abs(x[-recent:]), 90)),  # how far the chest or back swings at all
            "br_range_m": float(self.rng[cand[group]].mean()),
            "br_moving": float(shifting[-recent:].mean()),  # share of the time the body itself was shifting
            "br_moving_now": float(shifting[-int(10 * fs) :].mean()),  # the same over the last 10 s: what the quality goes by
            "breaths": breaths,
            "wave": x,
            "shifting": shifting,
        }
