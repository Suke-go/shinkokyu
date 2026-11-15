//! Heart and breathing rate from a window of heatmap frames. Same method as radar/vitals.py.
use crate::radar::{Chirp, N_ANT};
use rustfft::{num_complex::Complex64, FftPlanner};
use serde::Serialize;
use std::f64::consts::PI;

#[derive(Serialize)]
pub struct Estimate {
    pub range_m: f64,
    /// peak-to-peak chest displacement in the breathing band
    pub span_mm: f64,
    pub br_bpm: f64,
    pub br_q: f64,
    pub hr_bpm: f64,
    /// share of the heart band's power within 0.1 Hz of the peak
    pub hr_q: f64,
    pub hr_harmonic: bool,
    #[serde(skip)]
    pub disp_mm: Vec<f64>,
}

/// -> (peak Hz, share of the band's power within 0.1 Hz of the peak, band-limited signal)
fn band_peak(sig: &[f64], fs: f64, lo: f64, hi: f64) -> (f64, f64, Vec<f64>) {
    let n = sig.len();
    let nf = n as f64;
    // remove the least-squares line
    let (mx, my) = ((nf - 1.0) / 2.0, sig.iter().sum::<f64>() / nf);
    let (sxy, sxx) = sig.iter().enumerate().fold((0.0, 0.0), |(a, b), (i, y)| {
        let dx = i as f64 - mx;
        (a + dx * (y - my), b + dx * dx)
    });
    let x: Vec<f64> = sig.iter().enumerate().map(|(i, y)| y - my - sxy / sxx * (i as f64 - mx)).collect();

    let mut planner = FftPlanner::new();
    let nfft = (n * 8).next_power_of_two();
    let mut spec: Vec<Complex64> = x.iter().enumerate().map(|(i, v)| Complex64::new(v * (0.5 - 0.5 * (2.0 * PI * i as f64 / (nf - 1.0)).cos()), 0.0)).collect();
    spec.resize(nfft, Complex64::default());
    planner.plan_fft_forward(nfft).process(&mut spec);
    let df = fs / nfft as f64;
    let power = |k: usize| spec[k].norm_sqr();
    let (k_lo, k_hi) = ((lo / df).ceil() as usize, (hi / df).floor() as usize);
    // A peak is a local maximum: the skirt of slow drift below the band is highest at the band edge.
    let (mut peak, mut max, mut total) = (None::<usize>, k_lo, 0.0);
    for k in k_lo..=k_hi {
        let p = power(k);
        total += p;
        if p > power(max) {
            max = k;
        }
        if p > power(k - 1) && p >= power(k + 1) && peak.map_or(true, |b| p > power(b)) {
            peak = Some(k);
        }
    }
    let k = peak.unwrap_or(max);
    let near: f64 = (k_lo..=k_hi).filter(|&j| (j as f64 - k as f64).abs() * df <= 0.1).map(power).sum();

    let mut y: Vec<Complex64> = x.iter().map(|v| Complex64::new(*v, 0.0)).collect();
    planner.plan_fft_forward(n).process(&mut y);
    for (i, c) in y.iter_mut().enumerate() {
        let f = i.min(n - i) as f64 * fs / nf;
        if f < lo || f > hi {
            *c = Complex64::default();
        }
    }
    planner.plan_fft_inverse(n).process(&mut y);
    (k as f64 * df, near / total, y.iter().map(|c| c.re / nf).collect())
}

/// `frames[i]` is the heatmap payload of frame number `fnums[i]` (increasing).
pub fn analyze(fnums: &[u32], frames: &[&[u8]], chirp: &Chirp, rmin: f64, rmax: f64) -> Estimate {
    let (nb, w) = (chirp.n_bins, chirp.n_bins * N_ANT);
    // complex [time][bin * N_ANT + antenna] on a uniform grid: a dropped frame repeats the previous one
    let mut h: Vec<Complex64> = Vec::new();
    let mut j = 0;
    for g in fnums[0]..=fnums[fnums.len() - 1] {
        while j + 1 < fnums.len() && fnums[j + 1] <= g {
            j += 1;
        }
        h.extend(frames[j].chunks_exact(4).map(|c| Complex64::new(i16::from_le_bytes([c[2], c[3]]) as f64, i16::from_le_bytes([c[0], c[1]]) as f64)));
    }
    let t = h.len() / w;

    let mut mean = vec![Complex64::default(); w];
    for row in h.chunks_exact(w) {
        mean.iter_mut().zip(row).for_each(|(m, v)| *m += v);
    }
    let mut motion = vec![0.0; nb];
    for row in h.chunks_exact(w) {
        for (i, v) in row.iter().enumerate() {
            motion[i / N_ANT] += (v - mean[i] / t as f64).norm_sqr();
        }
    }
    let range = |b: usize| b as f64 * chirp.range_res;
    for (b, m) in motion.iter_mut().enumerate() {
        if range(b) < rmin || range(b) > rmax {
            *m = 0.0;
        }
    }
    let max = motion.iter().cloned().fold(0.0, f64::max);
    let bins: Vec<usize> = (0..nb).filter(|&b| motion[b] >= 0.25 * max).collect();

    // Frame-to-frame phase step, power-weighted over the body's range bins and all antennas,
    // so a fade in one bin or antenna carries little weight.
    let dphi: Vec<f64> = (1..t)
        .map(|ti| {
            let (now, prev) = (&h[ti * w..(ti + 1) * w], &h[(ti - 1) * w..ti * w]);
            bins.iter().flat_map(|&b| b * N_ANT..(b + 1) * N_ANT).map(|i| now[i] * prev[i].conj()).sum::<Complex64>().arg()
        })
        .collect();
    let mm = chirp.wavelength / (4.0 * PI) * 1e3;
    let mut disp_mm: Vec<f64> = dphi.iter().scan(0.0, |acc, d| { *acc += d * mm; Some(*acc) }).collect();
    let mean_disp = disp_mm.iter().sum::<f64>() / disp_mm.len() as f64;
    disp_mm.iter_mut().for_each(|d| *d -= mean_disp);

    let (br_f, br_q, br_sig) = band_peak(&disp_mm, chirp.frame_hz, 0.1, 0.6);
    // Heart rate from velocity: breathing is far larger than the heartbeat in displacement.
    let vel: Vec<f64> = dphi.iter().map(|d| d * mm * chirp.frame_hz).collect();
    let (hr_f, hr_q, _) = band_peak(&vel, chirp.frame_hz, 0.8, 2.5);
    let (lo, hi) = br_sig.iter().fold((f64::MAX, f64::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    Estimate {
        range_m: bins.iter().map(|&b| range(b) * motion[b]).sum::<f64>() / bins.iter().map(|&b| motion[b]).sum::<f64>(),
        span_mm: hi - lo,
        br_bpm: br_f * 60.0,
        br_q,
        hr_bpm: hr_f * 60.0,
        hr_q,
        hr_harmonic: (2..7).any(|k| (hr_f - k as f64 * br_f).abs() < 0.05),
        disp_mm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 18 breaths/min (3 mm) + 69 bpm (0.1 mm) at 0.6 m over static clutter, with dropped frames.
    #[test]
    fn finds_breathing_and_heartbeat() {
        let chirp = Chirp::load();
        let target = (0.6 / chirp.range_res).round() as usize;
        let (mut fnums, mut frames) = (Vec::new(), Vec::new());
        for ti in 0..(30.0 * chirp.frame_hz) as u32 {
            if ti % 97 == 5 {
                continue;
            }
            let s = ti as f64 / chirp.frame_hz;
            let d = 3e-3 * (2.0 * PI * 0.3 * s).sin() + 0.1e-3 * (2.0 * PI * 1.15 * s).sin();
            let phase = 4.0 * PI * d / chirp.wavelength;
            let mut iq = Vec::new();
            for b in 0..chirp.n_bins {
                for a in 0..N_ANT {
                    let (mut re, mut im) = ((b * 37 % 300) as f64 - 150.0, (a * 91 % 300) as f64 - 150.0);
                    if b == target {
                        re += 2000.0 * phase.cos();
                        im += 2000.0 * phase.sin();
                    }
                    iq.extend((im.round() as i16).to_le_bytes());
                    iq.extend((re.round() as i16).to_le_bytes());
                }
            }
            fnums.push(ti);
            frames.push(iq);
        }
        let refs: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
        let e = analyze(&fnums, &refs, &chirp, 0.3, 1.5);
        assert!((e.range_m - 0.6).abs() < chirp.range_res, "range {}", e.range_m);
        assert!((e.br_bpm - 18.0).abs() < 1.5, "br {}", e.br_bpm);
        assert!((e.hr_bpm - 69.0).abs() < 3.0, "hr {}", e.hr_bpm);
        assert!(e.hr_q > 0.5, "q {}", e.hr_q);
        assert!((e.span_mm - 6.0).abs() < 1.0, "span {}", e.span_mm);
    }
}
