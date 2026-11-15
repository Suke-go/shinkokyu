//! Local clock and its offset to the typing experiment's clock (SPEC §3.B).
use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// The project's Supabase URL and publishable key, from the same file the typing page reads.
fn supabase(key: &str) -> &'static str {
    const CFG: &str = include_str!("../../../../public/shared/config.js");
    (|| {
        let rest = &CFG[CFG.find(&format!("{key}:"))?..];
        let a = rest.find('\'')? + 1;
        Some(&rest[a..a + rest[a..].find('\'')?])
    })()
    .unwrap_or("")
}

type Fetch = Box<dyn Fn() -> Result<(f64, f64), String>>;

/// Same choice as the typing page (public/shared/backend.js): the Node server if it answers,
/// else Supabase rpc/server_time, so both sides are corrected to one clock.
fn time_source(backend: &str, server: &str) -> Result<(&'static str, Fetch), String> {
    let es = |e: &dyn std::fmt::Display| e.to_string();
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build(); // keep-alive: no handshake inside t0..t3
    if backend != "supabase" {
        let (a, url) = (agent.clone(), format!("{}/api/time", server.trim_end_matches('/')));
        let fetch = move || -> Result<(f64, f64), String> {
            let body = a.get(&url).call().map_err(|e| es(&e))?.into_string().map_err(|e| es(&e))?;
            let v: Value = serde_json::from_str(&body).map_err(|e| es(&e))?;
            Ok((v["t1"].as_f64().ok_or("t1")?, v["t2"].as_f64().ok_or("t2")?))
        };
        match fetch() {
            Ok(_) => return Ok(("server", Box::new(fetch))),
            Err(e) if backend == "server" => return Err(e),
            Err(_) => {}
        }
    }
    if supabase("url").is_empty() {
        return Err("タイピングサーバーにも Supabase にも接続できません".into());
    }
    let url = format!("{}/rest/v1/rpc/server_time", supabase("url").trim_end_matches('/'));
    Ok(("supabase", Box::new(move || {
        let r = agent.post(&url).set("apikey", supabase("key")).set("Content-Type", "application/json").send_string("{}");
        let n: f64 = r.map_err(|e| es(&e))?.into_string().map_err(|e| es(&e))?.trim().parse().map_err(|e| es(&e))?;
        Ok((n, n)) // t1 = t2, as in backend.js
    })))
}

pub fn ntp_sample(t0: f64, t1: f64, t2: f64, t3: f64) -> Value {
    json!({ "t0": t0, "t1": t1, "t2": t2, "t3": t3, "offset": ((t1 - t0) + (t2 - t3)) / 2.0, "delay": (t3 - t0) - (t2 - t1) })
}

/// 20 round trips, the first 3 dropped, offset of the fastest one. Shaped like the sync results in
/// SPEC §3, so clock.js makeOffsetFn reads it as is.
pub fn sync(clock: &Clock, backend: &str, server: &str, phase: &str) -> Result<Value, String> {
    let (source, fetch) = time_source(backend, server)?;
    let mut samples = Vec::new();
    for i in 0..20 {
        let t0 = clock.now_ms();
        let (t1, t2) = fetch()?;
        let t3 = clock.now_ms();
        if i >= 3 {
            samples.push(ntp_sample(t0, t1, t2, t3));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let delay = |s: &Value| s["delay"].as_f64().unwrap();
    let best = samples.iter().min_by(|a, b| delay(a).total_cmp(&delay(b))).unwrap().clone();
    Ok(json!({ "phase": phase, "source": source, "offset": best["offset"], "delay": best["delay"], "n": samples.len(), "at": best["t3"], "samples": samples }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_100ms_behind_with_4ms_round_trip() {
        let s = ntp_sample(1000.0, 1102.0, 1103.0, 1005.0);
        assert_eq!((s["offset"].as_f64(), s["delay"].as_f64()), (Some(100.0), Some(4.0)));
    }

    #[test]
    fn reads_supabase_config() {
        assert!(supabase("url").starts_with("https://"));
        assert!(supabase("key").starts_with("sb_publishable_"));
    }
}
