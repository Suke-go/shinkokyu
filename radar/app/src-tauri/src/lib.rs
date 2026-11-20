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
}

/// Measure until `stop` is set. Events for the UI: "status" {state, text?, progress?},
/// "seen" {db} twice a second (reflection per range bin from RMIN_M to RMAX_M, in dB over
/// the noise floor: what the radar is pointed at right now) and "estimate" {t, window, ...Estimate, disp}.
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
            "clock": if opts.session_id.is_some() { "the typing page's local clock: convert with that session's syncs" } else { "this PC's clock, unsynced" },
        });
        std::fs::write(path("json"), meta.to_string()).map_err(es)?;
        rec = Some(BufWriter::new(File::create(path("bin")).map_err(es)?));
        hr_log = Some(File::create(path("hr.jsonl")).map_err(es)?);
    }
    let win = (WINDOW_S * chirp.frame_hz) as usize;
    let mut window: VecDeque<(u32, Vec<u8>)> = VecDeque::with_capacity(win);
    let (mut anchor, mut last_fnum, mut configured, mut last_est) = (f64::INFINITY, None::<u32>, false, Instant::now());
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
                        if window.len() == win {
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
                    if last_est.elapsed() < Duration::from_secs(2) {
                        continue;
                    }
                    last_est = Instant::now();
                    if let Some(rec) = &mut rec {
                        rec.flush().map_err(fatal)?;
                    }
                    if window.len() < win {
                        emit("status", json!({ "state": "collecting", "progress": window.len() as f64 / win as f64 }));
                        continue;
                    }
                    let fnums: Vec<u32> = window.iter().map(|f| f.0).collect();
                    let frames: Vec<&[u8]> = window.iter().map(|f| f.1.as_slice()).collect();
                    let est = vitals::analyze(&fnums, &frames, &chirp, RMIN_M, RMAX_M);
                    let mut row = serde_json::to_value(&est).unwrap();
                    row["t"] = json!(anchor + fnums[win - 1] as f64 * chirp.frame_ms);
                    row["window"] = json!(WINDOW_S);
                    if let Some(log) = &mut hr_log {
                        writeln!(log, "{row}").map_err(fatal)?;
                    }
                    row["disp"] = json!(est.disp_mm);
                    emit("estimate", row);
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

struct Running {
    session_id: Option<String>,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct AppState(Mutex<Option<Running>>);

/// Same rule as the typing server's session ids; the id becomes part of a file name.
fn valid_session_id(id: &str) -> bool {
    (1..=160).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Without arguments: show estimates only (aiming the radar). With a typing session and that
/// page's current clock reading: also record, into Documents/shinkokyu-radar/radar_<session>.*,
/// on the page's clock.
#[tauri::command(async)]
fn start(app: tauri::AppHandle, state: tauri::State<AppState>, session: Option<String>, page_now: Option<f64>) -> Result<(), String> {
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
    let stem = match &session {
        Some(id) if valid_session_id(id) => {
            let dir = app.path().document_dir().map_err(|e| e.to_string())?.join("shinkokyu-radar");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            Some(dir.join(format!("radar_{id}")))
        }
        Some(_) => return Err("invalid session id".into()),
        None => None,
    };
    let opts = Options { clock, clock_offset_ms, session_id: session.clone(), stem };
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

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![start, stop])
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
    fn session_ids_are_safe_file_names() {
        assert!(super::valid_session_id("demo-ja_P01_20261115-100409"));
        for bad in ["", "../x", "a b", "a.b", "a/b", &"x".repeat(161)] {
            assert!(!super::valid_session_id(bad), "{bad}");
        }
    }
}
