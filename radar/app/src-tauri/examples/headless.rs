//! The app's measuring loop without a window, for checking against hardware and saved captures.
//!
//!     cargo run --example headless -- record 60 out/radar_test     # 60 s from the radar
//!     cargo run --example headless -- replay capture.bin           # estimates for a saved .bin
use shinkokyu_radar::radar::{Chirp, N_ANT};
use shinkokyu_radar::{breathing, measure, vitals, Clock, Options};
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["record", seconds, stem] => {
            let stop = AtomicBool::new(false);
            let opts = Options { clock: Clock::new(), clock_offset_ms: 0.0, session_id: None, stem: Some(stem.into()) };
            std::thread::scope(|s| {
                s.spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs_f64(seconds.parse().expect("seconds")));
                    stop.store(true, Relaxed);
                });
                let result = measure(&opts, &stop, &|name, mut v| {
                    if name == "live" {
                        return;
                    }
                    v.as_object_mut().map(|o| o.remove("breaths"));
                    println!("{name} {v}");
                });
                println!("{result:?}");
            });
        }
        ["replay", bin] => {
            let chirp = Chirp::load();
            let rec = 12 + chirp.n_bins * N_ANT * 4;
            let data = std::fs::read(bin).expect("read .bin");
            let (win, look, hop) = ((20.0 * chirp.frame_hz) as usize, (breathing::SELECT_S * chirp.frame_hz) as usize, (2.0 * chirp.frame_hz) as usize);
            let records: Vec<&[u8]> = data.chunks_exact(rec).collect();
            let mut breath = breathing::Breathing::new(&chirp, 0.3, 1.5);
            for (i, end) in (win..=records.len()).step_by(hop).enumerate() {
                let w = &records[end.saturating_sub(look)..end];
                let fnums: Vec<u32> = w.iter().map(|r| u32::from_le_bytes(r[8..12].try_into().unwrap())).collect();
                let frames: Vec<&[u8]> = w.iter().map(|r| &r[12..]).collect();
                let h = vitals::grid(&fnums, &frames);
                let b = breath.update(&h, if i == 0 { usize::MAX } else { hop });
                let e = vitals::analyze(&h[h.len() - win.min(w.len()) * chirp.n_bins * N_ANT..], &chirp, 0.3, 1.5);
                println!(
                    "{:5.0}s  breath {:4.1} s q {:.2} depth {:4.1} mm n {:2} moving {:3.0}%  heart {:5.1} q {:.2}  snr {:4.1} span {:.2}",
                    end as f64 / chirp.frame_hz, b.br_period_s.unwrap_or(f64::NAN), b.br_q, b.br_depth_mm, b.breaths.len(), b.br_moving * 100.0, b.hr_bpm.unwrap_or(f64::NAN), b.hr_q, e.snr_db, b.br_span_mm
                );
            }
        }
        _ => eprintln!("usage: headless record <seconds> <stem> | headless replay <file.bin>"),
    }
}
