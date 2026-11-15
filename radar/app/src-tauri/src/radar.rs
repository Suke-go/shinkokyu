//! Serial link to the kit: chirp configuration, port discovery, CLI, data-frame parser.
use serialport::{ClearBuffer, SerialPort, SerialPortType};
use std::io::ErrorKind;
use std::time::{Duration, Instant};

pub const N_ANT: usize = 4;
const MAGIC: [u8; 8] = [2, 1, 4, 3, 6, 5, 8, 7];
const TLV_AZIMUTH_STATIC_HEATMAP: u32 = 4;
const PROMPT: &str = "mmwDemo:/>";
const C: f64 = 299_792_458.0;

pub enum Fail {
    /// The USB link dropped or is not there yet: try again.
    Retry(String),
    Fatal(String),
}

pub struct Chirp {
    pub lines: Vec<String>,
    pub n_bins: usize,
    pub frame_ms: f64,
    pub frame_hz: f64,
    pub range_res: f64,
    pub wavelength: f64,
}

impl Chirp {
    pub fn load() -> Chirp {
        Chirp::parse(include_str!("../../../chirp.cfg"))
    }

    fn parse(cfg: &str) -> Chirp {
        let lines: Vec<String> = cfg.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('%')).map(String::from).collect();
        let field = |cmd: &str, i: usize| -> f64 {
            let line = lines.iter().find(|l| l.starts_with(cmd)).unwrap_or_else(|| panic!("chirp.cfg: no {cmd}"));
            line.split_whitespace().nth(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("chirp.cfg: {cmd} field {i}"))
        };
        let (start_ghz, adc_start_us, slope, n, ksps) = (field("profileCfg", 2), field("profileCfg", 4), field("profileCfg", 8), field("profileCfg", 10), field("profileCfg", 11));
        let frame_ms = field("frameCfg", 5);
        let center_hz = (start_ghz + slope * 1e-3 * (adc_start_us + n / ksps * 1e3 / 2.0)) * 1e9;
        Chirp {
            lines,
            n_bins: n as usize,
            frame_ms,
            frame_hz: 1000.0 / frame_ms,
            range_res: C * ksps * 1e3 / (2.0 * slope * 1e12 * n),
            wavelength: C / center_hz,
        }
    }
}

pub fn open(name: &str, baud: u32) -> Result<Box<dyn SerialPort>, Fail> {
    serialport::new(name, baud).timeout(Duration::from_millis(100)).open().map_err(|e| Fail::Retry(format!("{name}: {e}")))
}

/// Bytes that arrived within the port's timeout (0 if none).
pub fn read(port: &mut dyn SerialPort, buf: &mut [u8]) -> Result<usize, Fail> {
    match port.read(buf) {
        Ok(n) => Ok(n),
        Err(e) if e.kind() == ErrorKind::TimedOut => Ok(0),
        Err(e) => Err(Fail::Retry(e.to_string())),
    }
}

pub fn cli_send(cli: &mut dyn SerialPort, line: &str, timeout: Duration) -> Result<String, Fail> {
    let io = |e: std::io::Error| Fail::Retry(e.to_string());
    cli.clear(ClearBuffer::Input).map_err(|e| Fail::Retry(e.to_string()))?;
    cli.write_all(format!("{line}\n").as_bytes()).map_err(io)?;
    let (mut out, mut buf, t0) = (Vec::new(), [0u8; 256], Instant::now());
    while t0.elapsed() < timeout {
        let n = read(cli, &mut buf)?;
        out.extend_from_slice(&buf[..n]);
        if String::from_utf8_lossy(&out).contains(PROMPT) {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// (cli, data) serial ports of the kit's FT4232H.
///
/// The CLI port is the one that answers with the firmware prompt; the data port is the next
/// channel. Port numbers and names carry no such guarantee.
pub fn find_ports() -> Result<(String, String), Fail> {
    let mut ps: Vec<(String, String)> = serialport::available_ports()
        .map_err(|e| Fail::Retry(e.to_string()))?
        .into_iter()
        .filter_map(|p| match p.port_type {
            // macOS lists every port twice (cu.* and tty.*); cu.* is the one to open
            SerialPortType::UsbPort(u) if (u.vid, u.pid) == (0x0403, 0x6011) && !p.port_name.starts_with("/dev/tty.") => {
                Some((u.serial_number.unwrap_or_default(), p.port_name))
            }
            _ => None,
        })
        .collect();
    ps.sort();
    for i in 0..if ps.len() < 2 { 0 } else { ps.len() } {
        let (cli_name, data_name) = (&ps[i].1, &ps[(i + 1) % ps.len()].1);
        if let Ok(mut cli) = open(cli_name, 115_200) {
            if cli_send(cli.as_mut(), "", Duration::from_millis(500)).is_ok_and(|r| r.contains(PROMPT)) {
                return Ok((cli_name.clone(), data_name.clone()));
            }
        }
    }
    let names: Vec<&String> = ps.iter().map(|p| &p.1).collect();
    Err(Fail::Retry(format!("レーダーが見つかりません（FT4232H のポート: {names:?}）")))
}

pub fn configure(cli: &mut dyn SerialPort, chirp: &Chirp) -> Result<(), Fail> {
    for line in &chirp.lines {
        let reply = cli_send(cli, line, Duration::from_secs(10))?;
        if line != "sensorStop" && (!reply.contains("Done") || reply.contains("Error")) {
            return Err(Fail::Fatal(format!("レーダーが設定を拒否しました: {line}\n{}", reply.trim())));
        }
    }
    Ok(())
}

/// Splits the data UART stream into frames and keeps each frame's heatmap payload:
/// per range bin and antenna, int16 imag then int16 real.
pub struct Parser {
    buf: Vec<u8>,
    payload: usize,
}

impl Parser {
    pub fn new(chirp: &Chirp) -> Parser {
        Parser { buf: Vec::new(), payload: chirp.n_bins * N_ANT * 4 }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<(u32, Vec<u8>)> {
        let u32_at = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        self.buf.extend_from_slice(data);
        let mut frames = Vec::new();
        loop {
            let Some(i) = self.buf.windows(8).position(|w| w == MAGIC) else {
                let keep = self.buf.len().min(7);
                self.buf.drain(..self.buf.len() - keep);
                break;
            };
            self.buf.drain(..i);
            if self.buf.len() < 40 {
                break;
            }
            // header after the magic word: version, total length, platform, frame number, cpu time, objects, TLVs, subframe
            let (total, fnum, ntlv) = (u32_at(&self.buf, 12) as usize, u32_at(&self.buf, 20), u32_at(&self.buf, 32));
            if !(40..=65536).contains(&total) {
                self.buf.drain(..8);
                continue;
            }
            if self.buf.len() < total {
                break;
            }
            let pkt: Vec<u8> = self.buf.drain(..total).collect();
            let mut off = 40;
            for _ in 0..ntlv {
                if off + 8 > total {
                    break;
                }
                let (ty, len) = (u32_at(&pkt, off), u32_at(&pkt, off + 4) as usize);
                off += 8;
                if off + len > total {
                    break;
                }
                if ty == TLV_AZIMUTH_STATIC_HEATMAP && len == self.payload {
                    frames.push((fnum, pkt[off..off + len].to_vec()));
                }
                off += len;
            }
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chirp_cfg_gives_the_documented_numbers() {
        let c = Chirp::load();
        assert_eq!((c.n_bins, c.frame_hz), (64, 40.0));
        assert!((c.range_res - 0.0478).abs() < 1e-3 && (c.wavelength - 0.00379).abs() < 1e-5);
        assert_eq!(c.lines.first().unwrap(), "sensorStop");
        assert_eq!(c.lines.last().unwrap(), "sensorStart");
    }

    #[test]
    fn parser_survives_junk_other_tlvs_and_split_reads() {
        let chirp = Chirp::load();
        let iq: Vec<u8> = (0..chirp.n_bins * N_ANT * 4).map(|i| i as u8).collect();
        let mut tlvs = [2u32.to_le_bytes(), 8u32.to_le_bytes()].concat();
        tlvs.extend([0u8; 8]);
        tlvs.extend([4u32.to_le_bytes(), (iq.len() as u32).to_le_bytes()].concat());
        tlvs.extend(&iq);
        let mut pkt = MAGIC.to_vec();
        for v in [0x0305_0004u32, 40 + tlvs.len() as u32, 0xA1843, 7, 0, 0, 2, 0] {
            pkt.extend(v.to_le_bytes());
        }
        pkt.extend(&tlvs);
        let stream = [b"\x02\x01junk".to_vec(), pkt.clone(), pkt].concat();
        let mut p = Parser::new(&chirp);
        let got: Vec<(u32, Vec<u8>)> = stream.chunks(100).flat_map(|c| p.feed(c)).collect();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|(f, d)| *f == 7 && *d == iq));
    }
}
