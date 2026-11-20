"""Contactless heart / breathing rate from PTM RFR79ITR34-30U (TI IWR1843,
mmWave SDK 3.5 demo firmware), time-synced with the typing experiment.

    python radar/vitals.py                  # run until Ctrl+C
    python radar/vitals.py --seconds 60     # fixed-length capture

Same chirp (chirp.cfg), algorithm and file formats as the desktop app in
radar/app. See radar/README.md.
"""
import argparse
import http.client
import json
import re
import struct
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import serial
from serial.tools import list_ports

HERE = Path(__file__).parent
C = 299792458.0
MAGIC = bytes([2, 1, 4, 3, 6, 5, 8, 7])
HEADER = struct.Struct("<8I")  # fields after the magic word
TLV_AZIMUTH_STATIC_HEATMAP = 4
N_ANT = 4
# A person in the beam: a reflection well above the noise floor (a body gives 28-39 dB, an empty beam
# 7-13 dB) that also moves with breathing (millimetres; a chair or a wall stays within 0.2 mm).
SNR_MIN_DB = 26
SPAN_MIN_MM = 0.5

CONFIG = [l.strip() for l in (HERE / "chirp.cfg").read_text().splitlines() if l.strip() and not l.startswith("%")]
_profile = next(l for l in CONFIG if l.startswith("profileCfg")).split()
_frame = next(l for l in CONFIG if l.startswith("frameCfg")).split()
START_GHZ, ADC_START_US, SLOPE_MHZ_US = float(_profile[2]), float(_profile[4]), float(_profile[8])
N_SAMPLES, FS_KSPS = int(_profile[10]), float(_profile[11])
FRAME_MS = float(_frame[5])

FRAME_HZ = 1000.0 / FRAME_MS
RANGE_RES = C * FS_KSPS * 1e3 / (2 * SLOPE_MHZ_US * 1e12 * N_SAMPLES)
CENTER_HZ = (START_GHZ + SLOPE_MHZ_US * 1e-3 * (ADC_START_US + N_SAMPLES / FS_KSPS * 1e3 / 2)) * 1e9
WAVELENGTH = C / CENTER_HZ

# iq[range bin][antenna] = (imag, real), as the firmware sends it
REC = np.dtype([("t", "<f8"), ("fnum", "<u4"), ("iq", "<i2", (N_SAMPLES, N_ANT, 2))])

# Same clock construction as the browser's performance.timeOrigin + performance.now(): monotonic, so a
# wall-clock step mid-run cannot corrupt it. The origin may be ~16 ms coarse (time.time() on Windows
# before Python 3.13); the sync offset absorbs that.
_EPOCH_MS, _PC0 = time.time() * 1000, time.perf_counter()


def now_ms():
    return _EPOCH_MS + (time.perf_counter() - _PC0) * 1000


def ntp_sample(t0, t1, t2, t3):
    return {"t0": t0, "t1": t1, "t2": t2, "t3": t3, "offset": ((t1 - t0) + (t2 - t3)) / 2, "delay": (t3 - t0) - (t2 - t1)}


def open_time_source(backend, server):
    """-> (name, fetch), fetch() -> (t1, t2) in server UTC ms.

    Same choice as the typing page (public/shared/backend.js): the Node server if it
    answers, else Supabase rpc/server_time, so both sides are corrected to one clock.
    """
    def keepalive(url, method, headers, body):  # one connection: no TCP/TLS handshake inside t0..t3
        u = urlsplit(url)
        conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.netloc, timeout=3)

        def call():
            conn.request(method, u.path, body, headers)
            return json.loads(conn.getresponse().read())
        return call

    if backend != "supabase":
        call = keepalive(server + "/api/time", "GET", {}, None)
        try:
            call()
            return "server", lambda: (lambda j: (j["t1"], j["t2"]))(call())
        except (OSError, ValueError, http.client.HTTPException):
            if backend == "server":
                raise
    cfg = (HERE.parent / "public/shared/config.js").read_text(encoding="utf-8")
    url, key = (re.search(rf"{k}:\s*'([^']*)'", cfg)[1] for k in ("url", "key"))
    if not url:
        raise OSError("no typing server and no Supabase url in config.js")
    call = keepalive(url.rstrip("/") + "/rest/v1/rpc/server_time", "POST", {"apikey": key, "Content-Type": "application/json"}, "{}")
    return "supabase", lambda: (lambda n: (n, n))(float(call()))  # t1=t2, as in backend.js


def sync_clock(backend, server, phase, n=20, gap=0.1, drop=3):
    """SPEC §3.B. None if no time source is reachable."""
    samples = []
    try:
        source, fetch = open_time_source(backend, server)
        for i in range(n):
            t0 = now_ms()
            t1, t2 = fetch()
            t3 = now_ms()
            if i >= drop:
                samples.append(ntp_sample(t0, t1, t2, t3))
            time.sleep(gap)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException) as e:
        print(f"WARNING: clock sync ({phase}) failed: {e!r}. Times stay unsynced.")
        return None
    best = min(samples, key=lambda s: s["delay"])
    print(f"clock sync ({phase}, {source}): offset {best['offset']:+.2f} ms, delay {best['delay']:.2f} ms")
    return {"phase": phase, "source": source, "offset": best["offset"], "delay": best["delay"], "n": len(samples), "at": best["t3"], "samples": samples}


def cli_send(cli, line, timeout=10.0):
    cli.reset_input_buffer()
    cli.write((line + "\n").encode())
    buf = b""
    t0 = time.time()
    while time.time() - t0 < timeout:
        buf += cli.read(256)
        if b"mmwDemo:/>" in buf:
            break
    return buf.decode(errors="replace")


def find_ports():
    """(cli, data) serial ports of the kit's FT4232H.

    The CLI port is the one that answers with the firmware prompt; the data port is the
    next channel. Port numbers and names carry no such guarantee.
    """
    ps = [d for _, d in sorted((p.serial_number or "", p.device) for p in list_ports.comports() if (p.vid, p.pid) == (0x0403, 0x6011))]
    for cli_port, data_port in zip(ps, ps[1:] + ps[:1]):
        if cli_port == data_port:
            break
        with serial.Serial(cli_port, 115200, timeout=0.1) as cli:
            if "mmwDemo:/>" in cli_send(cli, "", 0.5):
                return cli_port, data_port
    raise serial.SerialException(f"radar not found (FT4232H serial ports seen: {ps})")


def configure(cli):
    for line in CONFIG:
        reply = cli_send(cli, line)
        if line == "sensorStop":
            continue
        if "Done" not in reply or "Error" in reply:
            raise RuntimeError(f"radar rejected '{line}':\n{reply.strip()}")


class FrameParser:
    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        """-> [(frame number, int16 iq[N_SAMPLES, N_ANT, 2])]"""
        self.buf += data
        frames = []
        while True:
            i = self.buf.find(MAGIC)
            if i < 0:
                del self.buf[: max(0, len(self.buf) - 7)]
                break
            if i:
                del self.buf[:i]
            if len(self.buf) < 40:
                break
            _ver, total, _plat, fnum, _cpu, _nobj, ntlv, _sub = HEADER.unpack_from(self.buf, 8)
            if not 40 <= total <= 65536:
                del self.buf[:8]
                continue
            if len(self.buf) < total:
                break
            pkt = bytes(self.buf[:total])
            del self.buf[:total]
            off, tlvs = 40, {}
            for _ in range(ntlv):
                if off + 8 > total:
                    break
                ttype, tlen = struct.unpack_from("<2I", pkt, off)
                off += 8
                tlvs[ttype] = pkt[off : off + tlen]
                off += tlen
            heat = tlvs.get(TLV_AZIMUTH_STATIC_HEATMAP)
            if heat is not None and len(heat) == N_SAMPLES * N_ANT * 4:
                frames.append((fnum, np.frombuffer(heat, "<i2").reshape(N_SAMPLES, N_ANT, 2)))
        return frames


def fill_gaps(fnums, H):
    """Put frames on a uniform time grid (dropped frames repeat the previous one)."""
    fnums = np.asarray(fnums)
    grid = np.arange(fnums[0], fnums[-1] + 1)
    return H[np.searchsorted(fnums, grid, side="right") - 1]


def band_peak(sig, lo, hi):
    """-> (peak Hz, share of the band's power within 0.1 Hz of the peak, band-limited signal, (Hz, power))"""
    n = len(sig)
    i = np.arange(n)
    x = sig - np.polyval(np.polyfit(i, sig, 1), i)
    nfft = 1 << int(np.ceil(np.log2(n * 8)))
    freq = np.fft.rfftfreq(nfft, 1 / FRAME_HZ)
    band = np.flatnonzero((freq >= lo) & (freq <= hi))
    spec = np.abs(np.fft.rfft(x * np.hanning(n), nfft)) ** 2
    f, s = freq[band], spec[band]
    # A peak is a local maximum: the skirt of slow drift below the band is highest at the band edge.
    peaks = np.flatnonzero((s > spec[band - 1]) & (s >= spec[band + 1]))
    k = int(peaks[s[peaks].argmax()]) if len(peaks) else int(s.argmax())
    X = np.fft.rfft(x)
    fx = np.fft.rfftfreq(n, 1 / FRAME_HZ)
    X[(fx < lo) | (fx > hi)] = 0
    return f[k], s[np.abs(f - f[k]) <= 0.1].sum() / s.sum(), np.fft.irfft(X, n), (f, s)


def analyze(H, rmin, rmax):
    """H: complex [time, range bin, antenna] on a uniform grid."""
    rng = np.arange(H.shape[1]) * RANGE_RES
    ac = H - H.mean(axis=0)
    motion = (np.abs(ac) ** 2).mean(axis=(0, 2))
    motion[(rng < rmin) | (rng > rmax)] = 0
    bins = np.flatnonzero(motion >= 0.25 * motion.max())
    amp = np.abs(H).mean(axis=(0, 2))
    snr_db = 20 * np.log10(amp[bins].max() / np.percentile(amp[rng >= rmin], 20))
    # Frame-to-frame phase step, power-weighted over the body's range bins and all antennas,
    # so a fade in one bin or antenna carries little weight.
    dphi = np.angle((H[1:, bins] * H[:-1, bins].conj()).sum(axis=(1, 2)))
    mm = WAVELENGTH / (4 * np.pi) * 1e3
    disp_mm = np.cumsum(dphi) * mm
    disp_mm -= disp_mm.mean()

    br_f, br_q, br_sig, _ = band_peak(disp_mm, 0.1, 0.6)
    # Heart rate from velocity: breathing is far larger than the heartbeat in displacement.
    hr_f, hr_q, hr_sig, hr_spec = band_peak(dphi * mm * FRAME_HZ, 0.8, 2.5)
    return {
        "present": bool(snr_db >= SNR_MIN_DB and np.ptp(br_sig) >= SPAN_MIN_MM),
        "snr_db": float(snr_db),
        "range_m": float(rng[bins] @ motion[bins] / motion[bins].sum()),
        "span_mm": float(np.ptp(br_sig)),
        "br_bpm": float(br_f * 60),
        "br_q": float(br_q),
        "hr_bpm": float(hr_f * 60),
        "hr_q": float(hr_q),
        "hr_harmonic": any(abs(hr_f - k * br_f) < 0.05 for k in range(2, 7)),
        "disp_mm": disp_mm,
        "br_sig": br_sig,
        "hr_sig": hr_sig,
        "hr_spec": hr_spec,
    }


def describe(r):
    if not r["present"]:
        what = "nothing in the beam" if r["snr_db"] < SNR_MIN_DB else "something in the beam, but it does not breathe"
        return f"no person: {what} (reflection {r['snr_db']:.0f} dB over the floor, motion {r['span_mm']:.2f} mm). Re-aim the radar"
    notes = []
    if r["hr_q"] < 0.35:
        notes.append("HR peak weak")
    if r["hr_harmonic"]:
        notes.append("HR peak sits on a breathing harmonic")
    return (
        f"range {r['range_m']:.2f} m ({r['snr_db']:.0f} dB) | breathing {r['br_bpm']:4.1f}/min "
        f"(chest {r['span_mm']:.2f} mm) | heart {r['hr_bpm']:5.1f} bpm (q={r['hr_q']:.2f})"
        + (f"  [{'; '.join(notes)}]" if notes else "")
    )


def save_plot(r, path):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = np.arange(len(r["disp_mm"])) / FRAME_HZ
    fig, ax = plt.subplots(4, 1, figsize=(10, 10))
    ax[0].plot(t, r["disp_mm"])
    ax[0].set(title=f"Chest displacement at {r['range_m']:.2f} m", ylabel="mm")
    ax[1].plot(t, r["br_sig"])
    ax[1].set(title=f"Breathing band 0.1-0.6 Hz: {r['br_bpm']:.1f} /min", ylabel="mm")
    ax[2].plot(t, r["hr_sig"])
    ax[2].set(title="Heart band 0.8-2.5 Hz (velocity)", ylabel="mm/s", xlabel="s")
    f, s = r["hr_spec"]
    ax[3].plot(f * 60, s / s.max())
    ax[3].axvline(r["hr_bpm"], color="r", ls="--")
    ax[3].set(title=f"Heart band spectrum: peak {r['hr_bpm']:.1f} bpm", xlabel="bpm")
    fig.tight_layout()
    fig.savefig(path, dpi=110)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=0, help="capture length; 0 = until Ctrl+C")
    ap.add_argument("--window", type=float, default=20, help="analysis window [s]")
    ap.add_argument("--rmin", type=float, default=0.3, help="nearest chest distance [m]")
    ap.add_argument("--rmax", type=float, default=1.5, help="farthest chest distance [m]")
    ap.add_argument("--server", default="http://127.0.0.1:8787", help="typing server to sync the clock with")
    ap.add_argument("--backend", choices=["auto", "server", "supabase"], default="auto",
                    help="clock to sync with; must match the typing page's mode (auto = server if it answers, else supabase)")
    ap.add_argument("--out", default=str(HERE / "captures"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = out / ("radar_" + time.strftime("%Y%m%d-%H%M%S", time.gmtime()))
    meta = {
        "device": "PTM RFR79ITR34-30U (IWR1843, mmWave SDK 3.5 demo)", "config": CONFIG,
        "frameHz": FRAME_HZ, "rangeResM": RANGE_RES, "wavelengthM": WAVELENGTH,
        "window": args.window, "rmin": args.rmin, "rmax": args.rmax,
        "bin": "records of {t: float64 local arrival ms, fnum: uint32, iq: int16[%d][%d][imag,real]}" % (N_SAMPLES, N_ANT),
        "syncs": [],
    }

    def sync(phase):
        s = sync_clock(args.backend, args.server, phase)
        if s:
            meta["syncs"].append(s)
        Path(f"{stem}.json").write_text(json.dumps(meta))

    sync("start")
    win = int(args.window * FRAME_HZ)
    window = deque(maxlen=win)  # (fnum, complex H)
    anchor, last_fnum, last, result, configured = np.inf, -1, 0.0, None, False
    t0 = time.time()
    done = lambda: args.seconds and time.time() - t0 >= args.seconds
    try:
        with open(f"{stem}.bin", "ab") as rec, open(f"{stem}.hr.jsonl", "a") as hr_log:
            while True:
                try:  # a knock on the USB cable drops the link: reopen and carry on
                    cli_port, data_port = find_ports()
                    with serial.Serial(cli_port, 115200, timeout=0.1) as cli, serial.Serial(data_port, 921600, timeout=0.1) as data:
                        if hasattr(data, "set_buffer_size"):  # Windows only
                            data.set_buffer_size(rx_size=1 << 20)
                        try:
                            parser = FrameParser()
                            # On a reconnect the sensor is still streaming: don't restart it.
                            if not (configured and any(parser.feed(data.read(4096)) for _ in range(5))):
                                configure(cli)
                                configured = True
                                data.reset_input_buffer()
                            print(f"streaming on {cli_port}/{data_port}: {FRAME_HZ:g} frames/s. Sit still, chest facing the radar.")
                            while not done():
                                chunk = data.read(max(1, data.in_waiting))  # timestamp on arrival, not on a full buffer
                                t = now_ms()
                                for fnum, iq in parser.feed(chunk):
                                    rec.write(np.array((t, fnum, iq), dtype=REC).tobytes())
                                    if fnum < last_fnum:  # sensor was restarted: new frame clock
                                        anchor = np.inf
                                        window.clear()
                                    last_fnum = fnum
                                    # Earliest arrival relative to the radar's own frame clock = least USB delay.
                                    # shortcut: still ~15-20 ms late (frame processing + UART) and ignores crystal
                                    # drift (~50 ppm), upgrade if beat-level timing is needed.
                                    anchor = min(anchor, t - fnum * FRAME_MS)
                                    window.append((fnum, iq[..., 1] + 1j * iq[..., 0]))
                                if t - last >= 2000:
                                    last = t
                                    rec.flush()
                                    if len(window) < win:
                                        print(f"collecting... {len(window)}/{win} frames", flush=True)
                                        continue
                                    fnums = [f for f, _ in window]
                                    result = analyze(fill_gaps(fnums, np.array([h for _, h in window])), args.rmin, args.rmax)
                                    row = {"t": anchor + fnums[-1] * FRAME_MS, "window": args.window}
                                    row.update({k: v for k, v in result.items() if not isinstance(v, (np.ndarray, tuple))})
                                    hr_log.write(json.dumps(row) + "\n")
                                    hr_log.flush()
                                    print(describe(result), flush=True)
                        finally:
                            try:
                                cli_send(cli, "sensorStop", 2)
                            except serial.SerialException:
                                pass
                    break
                except serial.SerialException as e:
                    print(f"USB link problem ({e}); retrying...", flush=True)
                    time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        sync("end")
    if result:
        save_plot(result, f"{stem}.png")
    print(f"saved {stem}.json / .bin / .hr.jsonl" + (" / .png" if result else ""))


if __name__ == "__main__":
    main()
