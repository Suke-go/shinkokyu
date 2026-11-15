mod clock;
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

pub struct Options {
    /// output files are `<stem>.json`, `.bin`, `.hr.jsonl`
    pub stem: PathBuf,
    /// "auto", "server" or "supabase"
    pub backend: String,
    pub server: String,
}

/// UTC `YYYYMMDD-HHMMSS`, the stamp the typing server puts in session ids.
pub fn utc_stamp(secs: u64) -> String {
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

/// Record until `stop` is set. Events for the UI: "status" {state, text?, progress?} and
/// "estimate" {t, window, ...Estimate, disp}.
pub fn session(opts: &Options, stop: &AtomicBool, emit: &dyn Fn(&str, Value)) -> Result<(), String> {
    let es = |e: std::io::Error| e.to_string();
    let chirp = Chirp::load();
    let clock = clock::Clock::new();
    let path = |ext: &str| PathBuf::from(format!("{}.{ext}", opts.stem.display()));
    let mut meta = json!({
        "device": "PTM RFR79ITR34-30U (IWR1843, mmWave SDK 3.5 demo)", "app": env!("CARGO_PKG_VERSION"), "config": chirp.lines,
        "frameHz": chirp.frame_hz, "rangeResM": chirp.range_res, "wavelengthM": chirp.wavelength,
        "window": WINDOW_S, "rmin": RMIN_M, "rmax": RMAX_M,
        "bin": format!("records of {{t: float64 local arrival ms, fnum: uint32, iq: int16[{}][{N_ANT}][imag,real]}}", chirp.n_bins),
        "syncs": [],
    });
    let sync = |phase: &str, meta: &mut Value| -> Result<(), String> {
        emit("status", json!({ "state": "sync" }));
        match clock::sync(&clock, &opts.backend, &opts.server, phase) {
            Ok(s) => meta["syncs"].as_array_mut().unwrap().push(s),
            Err(e) => emit("status", json!({ "state": "sync", "text": format!("時刻同期に失敗しました（{e}）。未同期のまま記録します") })),
        }
        std::fs::write(path("json"), meta.to_string()).map_err(es)
    };
    sync("start", &mut meta)?;

    let mut rec = BufWriter::new(File::create(path("bin")).map_err(es)?);
    let mut hr_log = File::create(path("hr.jsonl")).map_err(es)?;
    let win = (WINDOW_S * chirp.frame_hz) as usize;
    let mut window: VecDeque<(u32, Vec<u8>)> = VecDeque::with_capacity(win);
    let (mut anchor, mut last_fnum, mut configured, mut last_est) = (f64::INFINITY, None::<u32>, false, Instant::now());

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
                    let t = clock.now_ms();
                    for (fnum, iq) in parser.feed(&buf[..n]) {
                        rec.write_all(&t.to_le_bytes()).and_then(|_| rec.write_all(&fnum.to_le_bytes())).and_then(|_| rec.write_all(&iq)).map_err(fatal)?;
                        if last_fnum.is_some_and(|l| fnum < l) {
                            // sensor was restarted: new frame clock
                            anchor = f64::INFINITY;
                            window.clear();
                        }
                        last_fnum = Some(fnum);
                        // Earliest arrival relative to the radar's own frame clock = least USB delay.
                        // shortcut: still ~15-20 ms late (frame processing + UART) and ignores crystal
                        // drift (~50 ppm), upgrade if beat-level timing is needed.
                        anchor = anchor.min(t - fnum as f64 * chirp.frame_ms);
                        if window.len() == win {
                            window.pop_front();
                        }
                        window.push_back((fnum, iq));
                    }
                    if last_est.elapsed() < Duration::from_secs(2) {
                        continue;
                    }
                    last_est = Instant::now();
                    rec.flush().map_err(fatal)?;
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
                    writeln!(hr_log, "{row}").map_err(fatal)?;
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
    rec.flush().map_err(es)?;
    sync("end", &mut meta)?;
    result
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

#[derive(Default)]
struct AppState(Mutex<Option<Running>>);

/// Starts a recording into Documents/shinkokyu-radar and returns the files' common stem.
#[tauri::command]
fn start(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<String, String> {
    let mut running = state.0.lock().unwrap();
    if running.as_ref().is_some_and(|r| !r.thread.is_finished()) {
        return Err("計測中です".into());
    }
    let dir = app.path().document_dir().map_err(|e| e.to_string())?.join("shinkokyu-radar");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let opts = Options { stem: dir.join(format!("radar_{}", utc_stamp(now))), backend: "auto".into(), server: "http://127.0.0.1:8787".into() };
    let stem = opts.stem.display().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let thread = std::thread::spawn(move || {
        let emit = |name: &str, payload: Value| {
            let _ = app.emit(name, payload);
        };
        let result = session(&opts, &flag, &emit);
        emit("stopped", json!({ "error": result.err() }));
    });
    *running = Some(Running { stop, thread });
    Ok(stem)
}

#[tauri::command]
fn stop(state: tauri::State<AppState>) {
    if let Some(r) = state.0.lock().unwrap().as_ref() {
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
            // closing the window mid-recording still stops the sensor and writes the end sync
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
}
