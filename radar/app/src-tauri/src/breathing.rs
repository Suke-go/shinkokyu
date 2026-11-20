//! Breathing cycles and heart rate from one track of the chest's (or back's) motion.
//! Same method, step for step, as radar/breathing.py: see its header for the reasoning.
use crate::radar::{Chirp, N_ANT};
use crate::vitals::{noise_floor, percentile};
use rustfft::{num_complex::Complex64, FftPlanner};
use serde::Serialize;
use std::collections::VecDeque;
use std::f64::consts::PI;

const SMOOTH_S: f64 = 0.35; // Gaussian sigmas: noise and heartbeat out,
const BASE_S: f64 = 2.5; //   posture drift out
const MIN_S: f64 = 1.7; // a breath lasts this long: 5 to 35 a minute
const MAX_S: f64 = 12.0;
const JUMP_MM_S: f64 = 25.0; // a breathing chest stays under this
const MOVE_MM_S: f64 = 12.0; // ... and under this once smoothed over half a second (provisional)
const MIN_DEPTH_MM: f64 = 0.3; // shallower than this is not a breath
pub const SELECT_S: f64 = 30.0; // the chest is looked for in this much data
const KEEP_S: f64 = 60.0; // length of the continuous track
// The chest is looked for among the bins that reflect at least MIN_DB over the noise floor (an empty beam shows
// 7-13 dB, a back 19-29, a chest 28-39) and lie within BODY_M of the strongest reflection: a weak bin far from
// the body is noise, however regularly it happens to move.
const MIN_DB: f64 = 16.0;
const BODY_M: f64 = 0.25;
const HEART_S: f64 = 20.0;
const HEART_HZ: (f64, f64) = (0.8, 2.5);

fn mean(x: &[f64]) -> f64 {
    x.iter().sum::<f64>() / x.len() as f64
}

fn median(x: &[f64]) -> f64 {
    percentile(x, 0.5)
}

/// A moving reflector draws an arc around whatever static reflection shares its bin (a chair back when
/// measuring from behind, clothing, a desk edge); the arc's centre is that static part. It is
/// subtracted only if the fit is a real arc and the static part is the stronger one: left in, it
/// shrinks and bends the phase swing.
fn remove_static(z: &mut [Complex64]) {
    let n = z.len() as f64;
    let m = z.iter().sum::<Complex64>() / n;
    let (mut sxx, mut sxy, mut syy, mut sxw, mut syw, mut sw) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for v in z.iter() {
        let (x, y) = ((v - m).re, (v - m).im);
        let w = x * x + y * y;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        sxw += x * w;
        syw += y * w;
        sw += w;
    }
    let det = sxx * syy - sxy * sxy;
    if det.abs() < 1e-9 * (sxx * syy).max(1e-30) {
        return; // a point or a line: no arc
    }
    let c = Complex64::new((syy * sxw - sxy * syw) / (2.0 * det), (sxx * syw - sxy * sxw) / (2.0 * det));
    let r = (sw / n + c.norm_sqr()).max(0.0).sqrt();
    let resid = (z.iter().map(|v| ((v - m - c).norm() - r).powi(2)).sum::<f64>() / n).sqrt();
    if r > 0.0 && resid < 0.3 * r && (m + c).norm() > r {
        z.iter_mut().for_each(|v| *v -= m + c);
    }
}

/// Gaussian smoothing with mirrored edges.
fn gauss(x: &[f64], sigma_s: f64, fs: f64) -> Vec<f64> {
    let k = (4.0 * sigma_s * fs) as isize;
    let g: Vec<f64> = (-k..=k).map(|i| (-0.5 * (i as f64 / (sigma_s * fs)).powi(2)).exp()).collect();
    let total: f64 = g.iter().sum();
    let n = x.len() as isize;
    let at = |i: isize| -> f64 {
        if n == 1 {
            return x[0];
        }
        let p = 2 * (n - 1);
        let j = i.rem_euclid(p);
        x[(if j >= n { p - j } else { j }) as usize]
    };
    (0..n).map(|j| g.iter().enumerate().map(|(m, w)| w * at(j + m as isize - k)).sum::<f64>() / total).collect()
}

/// Chest velocity [mm/s] -> breathing wave [mm].
fn breath_wave(vel: &[f64], fs: f64) -> Vec<f64> {
    let d: Vec<f64> = vel.iter().scan(0.0, |acc, v| { *acc += v.clamp(-JUMP_MM_S, JUMP_MM_S) / fs; Some(*acc) }).collect();
    let s = gauss(&d, SMOOTH_S, fs);
    let base = gauss(&s, BASE_S, fs);
    s.iter().zip(base).map(|(a, b)| a - b).collect()
}

/// -> (period [s], regularity 0..1); period is NaN if the wave does not repeat.
fn period_of(x: &[f64], fs: f64) -> (f64, f64) {
    let n = x.len();
    let m = mean(x);
    let mut buf: Vec<Complex64> = x.iter().map(|v| Complex64::new(v - m, 0.0)).collect();
    buf.resize(2 * n, Complex64::default());
    let mut planner = FftPlanner::new();
    planner.plan_fft_forward(2 * n).process(&mut buf);
    buf.iter_mut().for_each(|c| *c = Complex64::new(c.norm_sqr(), 0.0));
    planner.plan_fft_inverse(2 * n).process(&mut buf);
    let ac0 = buf[0].re + 1e-12 * (2 * n) as f64;
    let ac: Vec<f64> = (0..n).map(|k| buf[k].re / ac0 * n as f64 / (n - k) as f64).collect();
    let (lo, hi) = ((MIN_S * fs) as usize, ((MAX_S * fs) as usize).min(n / 2));
    let mut floor = ac[..(lo + 1).min(n)].iter().cloned().fold(f64::INFINITY, f64::min);
    let mut peaks = Vec::new(); // (lag, swing between the dip before it and the peak)
    for k in lo + 1..hi.saturating_sub(1) {
        if ac[k] > ac[k - 1] && ac[k] >= ac[k + 1] {
            peaks.push((k, (ac[k] - floor) / 2.0));
        }
        floor = floor.min(ac[k]);
    }
    let Some(strongest) = peaks.iter().map(|p| p.1).reduce(f64::max) else { return (f64::NAN, 0.0) };
    // the first peak nearly as strong as the strongest: two or three periods are not the period
    let (k, swing) = *peaks.iter().find(|p| p.1 >= 0.85 * strongest).unwrap();
    (k as f64 / fs, swing.min(1.0))
}

/// True where the body itself is shifting (posture, leaning, reaching).
fn moving(vel: &[f64], fs: f64) -> Vec<bool> {
    let speed: Vec<f64> = vel.iter().map(|v| v.abs()).collect();
    gauss(&speed, 0.5, fs).iter().map(|v| *v > MOVE_MM_S).collect()
}

/// Breathing wave -> (start index, end index, depth mm) per breath. A breath runs from one upward zero
/// crossing to the next, with a rise above a threshold and then a dip below minus it in between.
fn cut_breaths(x: &[f64], fs: f64, shifting: &[bool]) -> Vec<(usize, usize, f64)> {
    let (block, span) = ((5.0 * fs) as usize, (15.0 * fs) as usize);
    let (mut out, mut armed, mut start, mut lo, mut hi) = (Vec::new(), false, None::<usize>, 0.0f64, 0.0f64);
    let mut b0 = 0;
    while b0 < x.len() {
        let end = (b0 + block).min(x.len());
        let recent: Vec<f64> = x[(b0 + block).saturating_sub(span).min(end)..end].iter().map(|v| v.abs()).collect();
        let h = (0.35 * median(&recent)).max(MIN_DEPTH_MM / 2.0);
        for i in b0.max(1)..end {
            lo = lo.min(x[i]);
            hi = hi.max(x[i]);
            armed = armed || (x[i] < -h && (hi > h || start.is_none())); // the first breath has no known start
            if armed && x[i - 1] <= 0.0 && 0.0 < x[i] {
                if let Some(s) = start {
                    let still = shifting[s..i].iter().filter(|m| **m).count() as f64 <= 0.1 * (i - s) as f64;
                    let len = (i - s) as f64 / fs;
                    if (MIN_S..=MAX_S).contains(&len) && hi - lo >= MIN_DEPTH_MM && still {
                        out.push((s, i, hi - lo));
                    }
                }
                (start, armed, lo, hi) = (Some(i), false, 0.0, 0.0);
            }
        }
        b0 += block;
    }
    out
}

/// Chest velocity [mm/s] -> (beats/min, share of the band's power within 0.1 Hz of that peak, beats/min of
/// the strongest peak as found). The first is None when the peak sits on a harmonic of the breathing
/// (`breath_s` = measured length of a breath) and nothing says it is the heart: breathing comes first.
fn heart_rate(vel: &[f64], fs: f64, prev: Option<f64>, breath_s: Option<f64>) -> (Option<f64>, f64, f64) {
    let n = vel.len();
    let d: Vec<f64> = vel.iter().scan(0.0, |acc, v| { *acc += v.clamp(-JUMP_MM_S, JUMP_MM_S) / fs; Some(*acc) }).collect();
    let smooth = gauss(&d, SMOOTH_S, fs);
    let rest: Vec<f64> = d.iter().zip(smooth).map(|(a, b)| a - b).collect();
    // what the breathing smoother left over, as velocity
    let x: Vec<f64> = (0..n)
        .map(|i| match i {
            0 => rest[1] - rest[0],
            i if i == n - 1 => rest[n - 1] - rest[n - 2],
            i => (rest[i + 1] - rest[i - 1]) / 2.0,
        } * fs)
        .collect();
    let nf = n as f64;
    let (mx, my) = ((nf - 1.0) / 2.0, mean(&x));
    let (sxy, sxx) = x.iter().enumerate().fold((0.0, 0.0), |(a, b), (i, y)| (a + (i as f64 - mx) * (y - my), b + (i as f64 - mx).powi(2)));
    let nfft = (n * 8).next_power_of_two();
    let mut buf: Vec<Complex64> = x
        .iter()
        .enumerate()
        .map(|(i, y)| Complex64::new((y - my - sxy / sxx * (i as f64 - mx)) * (0.5 - 0.5 * (2.0 * PI * i as f64 / (nf - 1.0)).cos()), 0.0))
        .collect();
    buf.resize(nfft, Complex64::default());
    FftPlanner::new().plan_fft_forward(nfft).process(&mut buf);
    let df = fs / nfft as f64;
    let (k_lo, k_hi) = ((HEART_HZ.0 / df).ceil() as usize, (HEART_HZ.1 / df).floor() as usize);
    let power = |k: usize| buf[k].norm_sqr();
    // each frequency scored together with its second harmonic
    let score: Vec<f64> = (k_lo..=k_hi).map(|k| power(k) + power(2 * k)).collect();
    let last = score.len() - 1;
    let mut peaks: Vec<usize> = (0..=last)
        .filter(|&j| score[j] > if j < last { score[j + 1] } else { 0.0 } && score[j] >= if j > 0 { score[j - 1] } else { 0.0 })
        .collect();
    if peaks.is_empty() {
        peaks.push((0..=last).max_by(|a, b| score[*a].total_cmp(&score[*b])).unwrap());
    }
    let strongest = |c: &[usize]| c.iter().copied().max_by(|a, b| score[*a].total_cmp(&score[*b]));
    let top = strongest(&peaks).unwrap();
    let hz = |j: usize| (k_lo + j) as f64 * df;
    let bpm = |j: usize| hz(j) * 60.0;
    let on_harmonic = |j: usize| breath_s.is_some_and(|b| (2..6).any(|h| (hz(j) - h as f64 / b).abs() < 0.05));
    let near = |limit: f64, share: f64| -> Vec<usize> {
        peaks.iter().copied().filter(|&j| prev.is_some_and(|p| (bpm(j) - p).abs() <= limit) && score[j] >= share * score[top]).collect()
    };
    // a heart rate does not jump 20 beats in 2 s: prefer a peak near the last one if it is half as strong
    let mut k = strongest(&near(10.0, 0.5)).unwrap_or(top);
    if on_harmonic(k) && !prev.is_some_and(|p| (bpm(k) - p).abs() <= 5.0) {
        let free: Vec<usize> = near(10.0, 0.1).into_iter().filter(|&j| !on_harmonic(j)).collect();
        match strongest(&free) {
            Some(j) => k = j,
            None => return (None, 0.0, bpm(top)),
        }
    }
    let total: f64 = (k_lo..=k_hi).map(power).sum();
    let around: f64 = (0..=last).filter(|&j| (hz(j) - hz(k)).abs() <= 0.1).map(|j| power(k_lo + j)).sum();
    (Some(bpm(k)), around / total, bpm(top))
}

#[derive(Serialize, Default)]
pub struct Out {
    pub hr_bpm: Option<f64>,
    pub hr_q: f64,
    pub hr_peak_bpm: Option<f64>,
    /// median length of the breaths that ended in the last SELECT_S, and the same as a rate
    pub br_period_s: Option<f64>,
    pub br_bpm: Option<f64>,
    /// how regularly the wave repeats, 0..1
    pub br_q: f64,
    pub br_depth_mm: f64,
    /// how far the chest or back swings at all
    pub br_span_mm: f64,
    pub br_range_m: Option<f64>,
    /// share of the last SELECT_S in which the body itself was shifting
    pub br_moving: f64,
    /// the same over the last 10 s: what the quality on the screen goes by, so it recovers quickly
    pub br_moving_now: f64,
    /// (seconds ago it ended, length s, depth mm) of the breaths that ended in the last SELECT_S
    #[serde(skip)]
    pub breaths: Vec<(f64, f64, f64)>,
    /// the breathing wave over the last SELECT_S, mm
    #[serde(skip)]
    pub wave: Vec<f64>,
}

/// Follows the chest from update to update and keeps one continuous breathing wave.
pub struct Breathing {
    fs: f64,
    mm: f64,
    range_res: f64,
    n_bins: usize,
    rmin: f64,
    rmax: f64,
    vel: VecDeque<f64>,
    chest: Option<usize>,
    hr: Option<f64>,
    /// range bins currently taken as the chest (empty until the first update finds one)
    pub bins: Vec<usize>,
}

impl Breathing {
    pub fn new(chirp: &Chirp, rmin: f64, rmax: f64) -> Breathing {
        Breathing { fs: chirp.frame_hz, mm: chirp.wavelength / (4.0 * PI) * 1e3, range_res: chirp.range_res, n_bins: chirp.n_bins, rmin, rmax, vel: VecDeque::new(), chest: None, hr: None, bins: Vec::new() }
    }

    pub fn reset(&mut self) {
        self.vel.clear();
        self.bins.clear();
        (self.chest, self.hr) = (None, None);
    }

    /// `h`: complex [time][bin * N_ANT + antenna] on a uniform grid, the latest frames.
    /// `n_new`: how many of them arrived since the last update.
    pub fn update(&mut self, h: &[Complex64], n_new: usize) -> Out {
        let (fs, w) = (self.fs, self.n_bins * N_ANT);
        let select = (SELECT_S * fs) as usize;
        let frames = &h[(h.len() / w).saturating_sub(select) * w..];
        let t = frames.len() / w;
        let range = |b: usize| b as f64 * self.range_res;
        let mut amp = vec![0.0; self.n_bins];
        for row in frames.chunks_exact(w) {
            row.iter().enumerate().for_each(|(i, v)| amp[i / N_ANT] += v.norm());
        }
        let floor = noise_floor(&amp, (self.rmin / self.range_res).ceil() as usize);
        let db: Vec<f64> = amp.iter().map(|a| 20.0 * (a / floor).log10()).collect();
        let near: Vec<usize> = (0..self.n_bins).filter(|&b| range(b) >= self.rmin && range(b) <= self.rmax).collect();
        let body = near.iter().copied().max_by(|a, b| db[*a].total_cmp(&db[*b])).map_or(0.0, range);
        let cand: Vec<usize> = near.into_iter().filter(|&b| db[b] >= MIN_DB && (range(b) - body).abs() <= BODY_M).collect();
        let n_new = if self.vel.is_empty() { t - 1 } else { n_new.min(t - 1) };
        let push = |vel: &mut VecDeque<f64>, v: f64| {
            if vel.len() == (KEEP_S * fs) as usize {
                vel.pop_front();
            }
            vel.push_back(v);
        };
        if cand.is_empty() {
            (0..n_new).for_each(|_| push(&mut self.vel, 0.0));
            self.bins.clear();
            (self.chest, self.hr) = (None, None);
            return Out::default();
        }
        // chest velocity per candidate bin
        let vel: Vec<Vec<f64>> = cand
            .iter()
            .map(|&b| {
                let cols: Vec<Vec<Complex64>> = (0..N_ANT)
                    .map(|a| {
                        let mut z: Vec<Complex64> = (0..t).map(|ti| frames[ti * w + b * N_ANT + a]).collect();
                        remove_static(&mut z);
                        z
                    })
                    .collect();
                (1..t).map(|ti| cols.iter().map(|z| z[ti] * z[ti - 1].conj()).sum::<Complex64>().arg() * self.mm * fs).collect()
            })
            .collect();
        let waves: Vec<Vec<f64>> = vel.iter().map(|v| breath_wave(v, fs)).collect();
        let regular: Vec<f64> = waves.iter().map(|x| period_of(x, fs).1).collect();
        let mut best = (0..cand.len()).max_by(|a, b| regular[*a].total_cmp(&regular[*b])).unwrap();
        // stay with the bin being followed unless another is clearly more regular
        if let Some(prev) = self.chest.and_then(|c| cand.iter().position(|&b| b == c)) {
            if regular[prev] >= 0.75 * regular[best] {
                best = prev;
            }
        }
        self.chest = Some(cand[best]);
        let corr = |x: &[f64], y: &[f64]| -> f64 {
            let (mx, my) = (mean(x), mean(y));
            let (sxy, sxx, syy) = x.iter().zip(y).fold((0.0, 0.0, 0.0), |(a, b, c), (p, q)| (a + (p - mx) * (q - my), b + (p - mx).powi(2), c + (q - my).powi(2)));
            let r = sxy / (sxx * syy).sqrt();
            if r.is_nan() { 0.0 } else { r }
        };
        let mut group: Vec<usize> = (0..cand.len()).filter(|&i| corr(&waves[best], &waves[i]) >= 0.6).collect();
        if group.is_empty() {
            group.push(best);
        }
        self.bins = group.iter().map(|&i| cand[i]).collect();
        for ti in t - 1 - n_new..t - 1 {
            push(&mut self.vel, group.iter().map(|&i| vel[i][ti]).sum::<f64>() / group.len() as f64);
        }

        let track: Vec<f64> = self.vel.iter().copied().collect();
        let x = breath_wave(&track, fs);
        let recent = &x[x.len().saturating_sub(select)..];
        let (mut period, q) = period_of(recent, fs);
        let shifting = moving(&track, fs);
        let first = x.len().saturating_sub(select);
        let breaths: Vec<(f64, f64, f64)> = cut_breaths(&x, fs, &shifting).into_iter().filter(|b| b.1 >= first).map(|(s, e, d)| ((x.len() - e) as f64 / fs, (e - s) as f64 / fs, d)).collect();
        if breaths.len() >= 2 {
            period = median(&breaths.iter().map(|b| b.1).collect::<Vec<_>>());
        }
        // breathing first: its harmonics are excluded from the heart rate only when the breathing itself is trusted
        let trusted = breaths.len() >= 2 && q >= 0.3;
        let (hr, hr_q, hr_peak) = heart_rate(&track[track.len().saturating_sub((HEART_S * fs) as usize)..], fs, self.hr, trusted.then_some(period));
        self.hr = hr.or(self.hr);
        let (lo, hi) = recent.iter().fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
        let period = (!period.is_nan()).then_some(period);
        Out {
            hr_bpm: hr,
            hr_q,
            hr_peak_bpm: Some(hr_peak),
            br_period_s: period,
            br_bpm: period.map(|p| 60.0 / p),
            br_q: q,
            br_depth_mm: if breaths.is_empty() { hi - lo } else { median(&breaths.iter().map(|b| b.2).collect::<Vec<_>>()) },
            br_span_mm: 2.0 * percentile(&recent.iter().map(|v| v.abs()).collect::<Vec<_>>(), 0.9),
            br_range_m: Some(group.iter().map(|&i| range(cand[i])).sum::<f64>() / group.len() as f64),
            br_moving: shifting[first..].iter().filter(|m| **m).count() as f64 / (shifting.len() - first) as f64,
            br_moving_now: {
                let recent = &shifting[shifting.len().saturating_sub((10.0 * fs) as usize)..];
                recent.iter().filter(|m| **m).count() as f64 / recent.len() as f64
            },
            breaths,
            wave: recent.to_vec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One reflector at 0.6 m moving `d(t)` metres, plus `clutter` static amplitude in the same bin.
    fn scene(chirp: &Chirp, seconds: f64, amp: f64, clutter: f64, d: impl Fn(f64) -> f64) -> Vec<Complex64> {
        let target = (0.6 / chirp.range_res).round() as usize;
        let mut h = Vec::new();
        for ti in 0..(seconds * chirp.frame_hz) as usize {
            let phase = 4.0 * PI * d(ti as f64 / chirp.frame_hz) / chirp.wavelength;
            for b in 0..chirp.n_bins {
                for a in 0..N_ANT {
                    // empty bins flicker a little, as real ones do
                    let mut v = Complex64::new(((b * 37 + ti * 7) % 11) as f64 - 5.0, ((a * 91 + ti * 3) % 11) as f64 - 5.0);
                    if b == target {
                        v += Complex64::from_polar(amp, phase) + Complex64::from_polar(clutter, 0.7);
                    }
                    h.push(v);
                }
            }
        }
        h
    }

    fn run(chirp: &Chirp, h: &[Complex64]) -> Out {
        let (w, hop, look) = (chirp.n_bins * N_ANT, (2.0 * chirp.frame_hz) as usize, (SELECT_S * chirp.frame_hz) as usize);
        let mut tracker = Breathing::new(chirp, 0.3, 1.5);
        let mut out = Out::default();
        let mut end = (20.0 * chirp.frame_hz) as usize;
        while end <= h.len() / w {
            out = tracker.update(&h[end.saturating_sub(look) * w..end * w], hop);
            end += hop;
        }
        out
    }

    #[test]
    fn chest_from_the_front_gives_breaths_and_heart_rate() {
        let chirp = Chirp::load();
        // 15 breaths a minute, 3 mm deep, with a 0.1 mm heartbeat at 69
        let h = scene(&chirp, 50.0, 1500.0, 0.0, |s| 1.5e-3 * (2.0 * PI * 0.25 * s).sin() + 0.1e-3 * (2.0 * PI * 1.15 * s).sin());
        let r = run(&chirp, &h);
        assert!((r.br_period_s.unwrap() - 4.0).abs() < 0.3 && (r.br_depth_mm - 3.0).abs() < 0.6, "{:?} {}", r.br_period_s, r.br_depth_mm);
        assert!((r.br_range_m.unwrap() - 0.6).abs() < chirp.range_res, "{:?}", r.br_range_m);
        assert!(r.breaths.iter().all(|b| (b.1 - 4.0).abs() < 0.4), "{:?}", r.breaths);
        assert!((r.hr_bpm.unwrap() - 69.0).abs() < 3.0 && r.hr_q > 0.35, "{:?} {}", r.hr_bpm, r.hr_q);
    }

    #[test]
    fn back_in_front_of_a_stronger_chair_back() {
        let chirp = Chirp::load();
        // a back moving 1 mm, 15 a minute, with a static reflection 4x as strong in the same bin
        let h = scene(&chirp, 60.0, 500.0, 2000.0, |s| 0.5e-3 * (2.0 * PI * 0.25 * s).sin());
        let r = run(&chirp, &h);
        assert!((r.br_period_s.unwrap() - 4.0).abs() < 0.3 && (r.br_depth_mm - 1.0).abs() < 0.2, "{:?} {}", r.br_period_s, r.br_depth_mm);
    }

    #[test]
    fn a_heart_band_peak_on_a_breathing_harmonic_is_not_a_heart_rate() {
        let fs = 40.0;
        let tone = |hz: f64, mm: f64| move |i: usize| 2.0 * PI * hz * mm * (2.0 * PI * hz * i as f64 / fs).cos();
        let harmonic: Vec<f64> = (0..800).map(tone(1.0, 0.3)).collect(); // 4th harmonic of a 4 s breath
        assert!((heart_rate(&harmonic, fs, None, None).0.unwrap() - 60.0).abs() < 2.0);
        assert!(heart_rate(&harmonic, fs, None, Some(4.0)).0.is_none());
        assert!((heart_rate(&harmonic, fs, Some(61.0), Some(4.0)).0.unwrap() - 60.0).abs() < 2.0); // it was the heart rate a moment ago
        let beat: Vec<f64> = (0..800).map(|i| tone(1.0, 0.3)(i) + tone(1.2, 0.1)(i)).collect(); // plus a weaker real heartbeat at 72
        assert!(heart_rate(&beat, fs, None, Some(4.0)).0.is_none());
        assert!((heart_rate(&beat, fs, Some(74.0), Some(4.0)).0.unwrap() - 72.0).abs() < 2.0);
    }
}
