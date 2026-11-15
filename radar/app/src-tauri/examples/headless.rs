//! The app's measuring loop without a window, for checking against hardware and saved captures.
//!
//!     cargo run --example headless -- record 60 out/radar_test     # 60 s from the radar
//!     cargo run --example headless -- replay capture.bin           # estimates for a saved .bin
use shinkokyu_radar::radar::{Chirp, N_ANT};
use shinkokyu_radar::{measure, vitals, Clock, Options};
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
                    v.as_object_mut().map(|o| o.remove("disp"));
                    println!("{name} {v}");
                });
                println!("{result:?}");
            });
        }
        ["replay", bin] => {
            let chirp = Chirp::load();
            let rec = 12 + chirp.n_bins * N_ANT * 4;
            let data = std::fs::read(bin).expect("read .bin");
            let win = (20.0 * chirp.frame_hz) as usize;
            let records: Vec<&[u8]> = data.chunks_exact(rec).collect();
            for end in (win..=records.len()).step_by((2.0 * chirp.frame_hz) as usize) {
                let w = &records[end - win..end];
                let fnums: Vec<u32> = w.iter().map(|r| u32::from_le_bytes(r[8..12].try_into().unwrap())).collect();
                let frames: Vec<&[u8]> = w.iter().map(|r| &r[12..]).collect();
                let e = vitals::analyze(&fnums, &frames, &chirp, 0.3, 1.5);
                println!("fnum {:6} hr {:6.1} q {:.2} br {:5.1} span {:5.2} range {:.2}", fnums[win - 1], e.hr_bpm, e.hr_q, e.br_bpm, e.span_mm, e.range_m);
            }
        }
        _ => eprintln!("usage: headless record <seconds> <stem> | headless replay <file.bin>"),
    }
}
