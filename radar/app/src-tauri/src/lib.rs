pub mod breathing;
pub mod radar;
pub mod vitals;

use radar::{Chirp, Fail, Parser, N_ANT};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

const WINDOW_S: f64 = 20.0;
const RMIN_M: f64 = 0.3;
const RMAX_M: f64 = 1.5;

/// Wall-clock origin plus a monotonic counter, like the browser's performance.timeOrigin +
/// performance.now(): a wall-clock step mid-run cannot corrupt it.
pub struct Clock {
    epoch_ms: f64,
    t0: Instant,
}

impl Clock {
    pub fn new() -> Clock {
        Clock { epoch_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0, t0: Instant::now() }
    }

    pub fn now_ms(&self) -> f64 {
        self.epoch_ms + self.t0.elapsed().as_secs_f64() * 1000.0
    }
}

pub struct Options {
    pub clock: Clock,
    /// Added to `clock` to get the typing page's local clock (0 without a typing session).
    pub clock_offset_ms: f64,
    /// Typing session the recording belongs to.
    pub session_id: Option<String>,
    /// Write `<stem>.json`, `.bin`, `.hr.jsonl`. None = show estimates only.
    pub stem: Option<PathBuf>,
    /// Take a baseline of resting breathing: stop by itself this many seconds after the first estimate
    /// and write `<stem>.baseline.json`. How much of that time the breathing was steady (quality 3) is
    /// reported, not waited for: the length of a baseline must not depend on thresholds.
    pub baseline_s: Option<f64>,
}

/// Measure until `stop` is set. Events for the UI: "status" {state, text?, progress?},
/// "seen" {db} twice a second (reflection per range bin from RMIN_M to RMAX_M, in dB over the noise
/// floor: what the radar is pointed at right now), "live" every second for the screen (the row below plus
/// the breathing wave of the last 30 s and where its breaths end) and "estimate" every 2 s for the record
/// (the row written to .hr.jsonl: t, window, present, snr_db, range_m, span_mm, br_*, hr_*, breaths).
/// With `baseline_s`, "live" carries baseline {have_s, need_s, steady_s} and "baseline" {summary} is sent at the end.
pub fn measure(opts: &Options, stop: &AtomicBool, emit: &dyn Fn(&str, Value)) -> Result<(), String> {
    let es = |e: std::io::Error| e.to_string();
    let chirp = Chirp::load();
    let now_ms = || opts.clock.now_ms() + opts.clock_offset_ms;
    let (mut rec, mut hr_log) = (None, None);
    if let Some(stem) = &opts.stem {
        let path = |ext: &str| PathBuf::from(format!("{}.{ext}", stem.display()));
        let meta = json!({
            "device": "PTM RFR79ITR34-30U (IWR1843, mmWave SDK 3.5 demo)", "app": env!("CARGO_PKG_VERSION"), "config": chirp.lines,
            "frameHz": chirp.frame_hz, "rangeResM": chirp.range_res, "wavelengthM": chirp.wavelength,
            "window": WINDOW_S, "rmin": RMIN_M, "rmax": RMAX_M,
            "bin": format!("records of {{t: float64 local arrival ms, fnum: uint32, iq: int16[{}][{N_ANT}][imag,real]}}", chirp.n_bins),
            "sessionId": opts.session_id,
            "clockOffsetMs": opts.clock_offset_ms,  // typing page's clock minus this PC's clock, measured when the session started
            "clock": if opts.session_id.is_some() { "the typing page's local clock: convert with that session's syncs" } else { "this PC's clock, unsynced" },
        });
        std::fs::write(path("json"), meta.to_string()).map_err(es)?;
        rec = Some(BufWriter::new(File::create(path("bin")).map_err(es)?));
        hr_log = Some(File::create(path("hr.jsonl")).map_err(es)?);
    }
    let win = (WINDOW_S * chirp.frame_hz) as usize;
    let keep = win.max((breathing::SELECT_S * chirp.frame_hz) as usize); // breathing looks further back than the rest
    let mut window: VecDeque<(u32, Vec<u8>)> = VecDeque::with_capacity(keep);
    let mut breath = breathing::Breathing::new(&chirp, RMIN_M, RMAX_M);
    let (mut anchor, mut last_fnum, mut configured, mut last_est) = (f64::INFINITY, None::<u32>, false, Instant::now());
    let (mut est_fnum, mut ticks) = (None::<u32>, 0u64);
    // baseline: steady seconds so far, when the last estimate was made, when the first one was, the breaths and heart rates collected
    let (mut steady_s, mut last_tick, mut begun) = (0.0f64, Instant::now(), None::<Instant>);
    let (mut kept, mut hearts): (Vec<(f64, f64, f64)>, Vec<f64>) = (Vec::new(), Vec::new());
    let (first_bin, end_bin) = ((RMIN_M / chirp.range_res).ceil() as usize, (RMAX_M / chirp.range_res) as usize + 1);
    let (mut seen, mut seen_frames, mut last_seen) = (vec![0.0; chirp.n_bins], 0, Instant::now());

    let result = loop {
        // one connection; a knock on the USB cable ends it with Fail::Retry
        let attempt = (|| -> Result<(), Fail> {
            emit("status", json!({ "state": "connecting" }));
            let (cli_name, data_name) = radar::find_ports()?;
            let (mut cli, mut data) = (radar::open(&cli_name, 115_200)?, radar::open(&data_name, 921_600)?);
            let mut stream = || -> Result<(), Fail> {
                let fatal = |e: std::io::Error| Fail::Fatal(e.to_string());
                let (mut parser, mut buf) = (Parser::new(&chirp), [0u8; 4096]);
                // On a reconnect the sensor is still streaming: don't restart it.
                let mut alive = false;
                let t0 = Instant::now();
                while configured && !alive && t0.elapsed() < Duration::from_millis(500) {
                    let n = radar::read(data.as_mut(), &mut buf)?;
                    alive = !parser.feed(&buf[..n]).is_empty();
                }
                if !alive {
                    radar::configure(cli.as_mut(), &chirp)?;
                    configured = true;
                    data.clear(serialport::ClearBuffer::Input).map_err(|e| Fail::Retry(e.to_string()))?;
                }
                while !stop.load(Relaxed) {
                    let n = radar::read(data.as_mut(), &mut buf)?;
                    let t = now_ms();
                    for (fnum, iq) in parser.feed(&buf[..n]) {
                        if let Some(rec) = &mut rec {
                            rec.write_all(&t.to_le_bytes()).and_then(|_| rec.write_all(&fnum.to_le_bytes())).and_then(|_| rec.write_all(&iq)).map_err(fatal)?;
                        }
                        if last_fnum.is_some_and(|l| fnum < l) {
                            // sensor was restarted: new frame clock
                            anchor = f64::INFINITY;
                            window.clear();
                            breath.reset();
                            est_fnum = None;
                        }
                        last_fnum = Some(fnum);
                        for (b, bin) in iq.chunks_exact(N_ANT * 4).enumerate() {
                            seen[b] += bin.chunks_exact(4).map(|c| (i16::from_le_bytes([c[2], c[3]]) as f64).hypot(i16::from_le_bytes([c[0], c[1]]) as f64)).sum::<f64>();
                        }
                        seen_frames += 1;
                        // Earliest arrival relative to the radar's own frame clock = least USB delay.
                        // shortcut: still ~15-20 ms late (frame processing + UART) and ignores crystal
                        // drift (~50 ppm), upgrade if beat-level timing is needed.
                        anchor = anchor.min(t - fnum as f64 * chirp.frame_ms);
                        if window.len() == keep {
                            window.pop_front();
                        }
                        window.push_back((fnum, iq));
                    }
                    if last_seen.elapsed() >= Duration::from_millis(500) && seen_frames > 0 {
                        let floor = vitals::noise_floor(&seen, first_bin);
                        let db: Vec<f64> = seen[first_bin..end_bin].iter().map(|a| 20.0 * (a / floor).max(1.0).log10()).collect();
                        emit("seen", json!({ "db": db }));
                        seen.fill(0.0);
                        (seen_frames, last_seen) = (0, Instant::now());
                    }
                    if last_est.elapsed() < Duration::from_secs(1) {
                        continue;
                    }
                    last_est = Instant::now();
                    ticks += 1;
                    if let Some(rec) = &mut rec {
                        rec.flush().map_err(fatal)?;
                    }
                    // the screen starts after 10 s (enough to see a couple of breaths), the record after 20 s
                    let first = win / 2;
                    if window.len() < first {
                        emit("status", json!({ "state": "collecting", "progress": window.len() as f64 / first as f64 }));
                        continue;
                    }
                    let fnums: Vec<u32> = window.iter().map(|f| f.0).collect();
                    let frames: Vec<&[u8]> = window.iter().map(|f| f.1.as_slice()).collect();
                    let h = vitals::grid(&fnums, &frames);
                    let (last, w) = (fnums[fnums.len() - 1], chirp.n_bins * N_ANT);
                    let est = vitals::analyze(&h[h.len() - win.min(h.len() / w) * w..], &chirp, RMIN_M, RMAX_M);
                    // breathing and heart rate from the one chest track; they replace the pooled-bin values
                    let b = breath.update(&h, est_fnum.map_or(usize::MAX, |f| (last - f) as usize));
                    est_fnum = Some(last);
                    let now = anchor + last as f64 * chirp.frame_ms;
                    let mut row = serde_json::to_value(&est).unwrap();
                    row.as_object_mut().unwrap().extend(serde_json::to_value(&b).unwrap().as_object().unwrap().clone());
                    row["t"] = json!(now);
                    row["window"] = json!(WINDOW_S);
                    let present = est.snr_db >= vitals::SNR_MIN_DB && b.br_span_mm >= vitals::SPAN_MIN_MM;
                    row["present"] = json!(present);
                    let q = quality(est.snr_db, present, &b);
                    row["quality"] = json!(q);
                    // each breath that ended in the last 30 s: when it ended, how long it took, how deep it was
                    row["breaths"] = b.breaths.iter().map(|(ago, period, depth)| json!({ "t": now - ago * 1000.0, "period_s": period, "depth_mm": depth })).collect();
                    if ticks % 2 == 0 && window.len() >= win {
                        if let Some(log) = &mut hr_log {
                            writeln!(log, "{row}").map_err(fatal)?;
                        }
                        emit("estimate", row.clone());
                    }
                    if let Some(need) = opts.baseline_s {
                        let elapsed = begun.get_or_insert_with(Instant::now).elapsed().as_secs_f64();
                        if q == 3 {
                            steady_s += last_tick.elapsed().as_secs_f64().min(2.0);
                        }
                        for (ago, period, depth) in &b.breaths {
                            let ended = now - ago * 1000.0;
                            if kept.last().map_or(true, |k| ended > k.0 + 1000.0) {
                                kept.push((ended, *period, *depth));
                            }
                        }
                        hearts.extend(b.hr_bpm.filter(|_| b.hr_q >= 0.35));
                        row["baseline"] = json!({ "have_s": elapsed, "need_s": need, "steady_s": steady_s });
                        if elapsed >= need {
                            let summary = baseline_summary(need, steady_s, elapsed, &kept, &hearts);
                            if let Some(stem) = &opts.stem {
                                std::fs::write(format!("{}.baseline.json", stem.display()), summary.to_string()).map_err(fatal)?;
                            }
                            emit("baseline", summary);
                            stop.store(true, Relaxed);
                        }
                    }
                    last_tick = Instant::now();
                    let n = b.wave.len() as f64;
                    row["wave"] = json!(b.wave);
                    row["cuts"] = b.breaths.iter().flat_map(|(ago, period, _)| [n - (ago + period) * chirp.frame_hz, n - ago * chirp.frame_hz]).filter(|i| *i >= 0.0).collect();
                    emit("live", row);
                }
                Ok(())
            };
            let r = stream();
            let _ = radar::cli_send(cli.as_mut(), "sensorStop", Duration::from_secs(2));
            r
        })();
        match attempt {
            Ok(()) => break Ok(()),
            Err(Fail::Fatal(e)) => break Err(e),
            Err(Fail::Retry(_)) if stop.load(Relaxed) => break Ok(()),
            Err(Fail::Retry(e)) => {
                emit("status", json!({ "state": "retry", "text": e }));
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    };
    if let Some(mut rec) = rec {
        rec.flush().map_err(es)?;
    }
    result
}

/// Signal quality, as shown by the bars on the screen: 0 nothing reflects, 1 something does, 2 it is a person
/// who breathes, 3 the breaths are being cut steadily (the state to start an experiment in).
fn quality(snr_db: f64, present: bool, b: &breathing::Out) -> u8 {
    match (snr_db >= vitals::SNR_MIN_DB, present) {
        (false, _) => 0,
        (true, false) => 1,
        (true, true) if b.breaths.len() >= 2 && b.br_q >= 0.3 && b.br_moving <= 0.2 => 3,
        (true, true) => 2,
    }
}

/// What a baseline recording found: `kept` = (end time ms, length s, depth mm) of its breaths.
fn baseline_summary(need_s: f64, steady_s: f64, took_s: f64, kept: &[(f64, f64, f64)], hearts: &[f64]) -> Value {
    let at = |v: Vec<f64>, p: f64| (!v.is_empty()).then(|| vitals::percentile(&v, p));
    let periods = || kept.iter().map(|k| k.1).collect::<Vec<_>>();
    let period = at(periods(), 0.5);
    json!({
        "need_s": need_s, "took_s": took_s,
        "steady_s": steady_s, "steady_share": (steady_s / took_s).min(1.0),  // how much of it the breathing was steady (quality 3)
        "breaths": kept.len(),
        "br_period_s": period, "br_bpm": period.map(|p| 60.0 / p),
        "br_period_iqr_s": at(periods(), 0.75).zip(at(periods(), 0.25)).map(|(a, b)| a - b),
        "br_depth_mm": at(kept.iter().map(|k| k.2).collect(), 0.5),
        "hr_bpm": at(hearts.to_vec(), 0.5),
        "t_first_breath": kept.first().map(|k| k.0), "t_last_breath": kept.last().map(|k| k.0),
    })
}

struct Running {
    session_id: Option<String>,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct AppState(Mutex<Option<Running>>);

/// UTC `YYYYMMDD-HHMMSS`, the stamp vitals.py and the typing server's session ids use.
fn utc_stamp(secs: u64) -> String {
    // days -> civil date (Howard Hinnant's algorithm)
    let z = (secs / 86400) as i64 + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + i64::from(m <= 2);
    let s = secs % 86400;
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", s / 3600, s % 3600 / 60, s % 60)
}

/// Same rule as the typing server's session ids; the id becomes part of a file name.
fn valid_session_id(id: &str) -> bool {
    (1..=160).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Records into Documents/shinkokyu-radar. With a typing session and that page's current clock
/// reading: radar_<session>.*, stamped on the page's clock. Without (the aiming screen):
/// radar_<UTC stamp>.*, stamped on this PC's clock; with `baseline_s` it ends by itself after that long.
#[tauri::command(async)]
fn start(app: tauri::AppHandle, state: tauri::State<AppState>, session: Option<String>, page_now: Option<f64>, baseline_s: Option<f64>) -> Result<(), String> {
    let clock = Clock::new();
    let clock_offset_ms = page_now.map_or(0.0, |p| p - clock.now_ms()); // taken first: the IPC delay is under a millisecond
    let mut running = state.0.lock().unwrap();
    if let Some(r) = running.take_if(|r| !r.thread.is_finished()) {
        if r.session_id.is_some() && session.is_none() {
            *running = Some(r);
            return Err("タイピング課題の記録中です".into());
        }
        r.stop.store(true, Relaxed);
        let _ = r.thread.join();
    }
    if session.as_ref().is_some_and(|id| !valid_session_id(id)) || baseline_s.is_some_and(|s| !(1.0..=3600.0).contains(&s)) {
        return Err("invalid session id or baseline length".into());
    }
    let dir = app.path().document_dir().map_err(|e| e.to_string())?.join("shinkokyu-radar");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = session.clone().unwrap_or_else(|| utc_stamp(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()));
    let stem = Some(dir.join(format!("radar_{name}")));
    let opts = Options { clock, clock_offset_ms, session_id: session.clone(), stem, baseline_s };
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::spawn(move || {
        let emit = |name: &str, payload: Value| {
            let _ = app.emit(name, payload);
        };
        let result = measure(&opts, &flag, &emit);
        emit("stopped", json!({ "error": result.err(), "session": opts.session_id }));
    });
    *running = Some(Running { session_id: session, stop, thread });
    Ok(())
}

/// Stops the measurement started with the same `session` (none = the estimates-only one).
#[tauri::command]
fn stop(state: tauri::State<AppState>, session: Option<String>) {
    if let Some(r) = state.0.lock().unwrap().as_ref().filter(|r| r.session_id == session) {
        r.stop.store(true, Relaxed);
    }
}

/// Keeps the typing session on this PC too, next to the radar recording and in the typing server's own
/// format: typing_<session>.json (the session's meta, rewritten whole) and typing_<session>.events.jsonl
/// (appended to). Returns the folder.
#[tauri::command(async)]
fn save_typing(app: tauri::AppHandle, session: String, name: String, text: String, append: bool) -> Result<String, String> {
    if !valid_session_id(&session) || !["json", "events.jsonl"].contains(&name.as_str()) || text.len() > 5 << 20 {
        return Err("invalid typing record".into());
    }
    let dir = app.path().document_dir().map_err(|e| e.to_string())?.join("shinkokyu-radar");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new().create(true).append(append).write(true).truncate(!append).open(dir.join(format!("typing_{session}.{name}"))).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![start, stop, save_typing])
        .build(tauri::generate_context!())
        .expect("failed to start")
        .run(|app, event| {
            // quitting mid-recording still stops the sensor and flushes the file
            if let tauri::RunEvent::Exit = event {
                let running = app.state::<AppState>().0.lock().unwrap().take();
                if let Some(r) = running {
                    r.stop.store(true, Relaxed);
                    let _ = r.thread.join();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn utc_stamp_matches_the_calendar() {
        assert_eq!(super::utc_stamp(1_794_737_049), "20261115-100409");
        assert_eq!(super::utc_stamp(951_782_400), "20000229-000000");
    }

    #[test]
    fn baseline_summary_is_the_median_breath() {
        let kept = [(1000.0, 4.0, 2.0), (5000.0, 5.0, 3.0), (10000.0, 6.0, 4.0)];
        let s = super::baseline_summary(180.0, 135.0, 180.0, &kept, &[70.0, 74.0]);
        assert_eq!(s["steady_share"].as_f64(), Some(0.75));
        assert_eq!((s["breaths"].as_u64(), s["br_period_s"].as_f64(), s["br_bpm"].as_f64(), s["br_period_iqr_s"].as_f64()), (Some(3), Some(5.0), Some(12.0), Some(1.0)));
        assert_eq!((s["br_depth_mm"].as_f64(), s["hr_bpm"].as_f64()), (Some(3.0), Some(72.0)));
        assert!(super::baseline_summary(180.0, 0.0, 10.0, &[], &[])["br_period_s"].is_null());
    }

    #[test]
    fn session_ids_are_safe_file_names() {
        assert!(super::valid_session_id("demo-ja_P01_20261115-100409"));
        for bad in ["", "../x", "a b", "a.b", "a/b", &"x".repeat(161)] {
            assert!(!super::valid_session_id(bad), "{bad}");
        }
    }
}
