"""python radar/test_vitals.py  (no radar needed)"""
import struct

import numpy as np

import vitals as v

# --- parser: one packet with a junk prefix, an unrelated TLV, split across reads
iq = np.arange(v.N_SAMPLES * v.N_ANT * 2, dtype="<i2").reshape(v.N_SAMPLES, v.N_ANT, 2)
tlvs = struct.pack("<2I", 2, 8) + b"\0" * 8 + struct.pack("<2I", 4, iq.nbytes) + iq.tobytes()
total = 40 + len(tlvs)
pkt = v.MAGIC + v.HEADER.pack(0x03050004, total, 0xA1843, 7, 0, 0, 2, 0) + tlvs
stream = b"\x02\x01junk" + pkt + pkt
p, got = v.FrameParser(), []
for i in range(0, len(stream), 100):
    got += p.feed(stream[i : i + 100])
assert [f for f, _ in got] == [7, 7] and (got[0][1] == iq).all()

# --- record layout stays what the meta file promises
assert v.REC.itemsize == 8 + 4 + v.N_SAMPLES * v.N_ANT * 4

# --- dropped frames are held, not skipped
H = np.arange(4)[:, None, None] * np.ones((1, 2, 2))
assert v.fill_gaps([10, 11, 13, 14], H)[:, 0, 0].tolist() == [0, 1, 1, 2, 3]

# --- clock: client 100 ms behind the server, 4 ms symmetric round trip
s = v.ntp_sample(1000, 1102, 1103, 1005)
assert s["offset"] == 100 and s["delay"] == 4

# --- vitals: 18 breaths/min (3 mm) + 69 bpm (0.1 mm) at 0.6 m, over static clutter
rng = np.random.default_rng(0)
t = np.arange(int(30 * v.FRAME_HZ)) / v.FRAME_HZ
d = 3e-3 * np.sin(2 * np.pi * 0.3 * t) + 0.1e-3 * np.sin(2 * np.pi * 1.15 * t)
b = round(0.6 / v.RANGE_RES)
shape = (len(t), v.N_SAMPLES, v.N_ANT)
H = 30 * (rng.standard_normal(shape[1:]) + 1j * rng.standard_normal(shape[1:])) + 5 * (rng.standard_normal(shape) + 1j * rng.standard_normal(shape))
H[:, b, :] += 2000 * np.exp(1j * 4 * np.pi * d / v.WAVELENGTH)[:, None]
r = v.analyze(H, 0.3, 1.5)
assert abs(r["range_m"] - 0.6) < v.RANGE_RES, r["range_m"]
assert abs(r["br_bpm"] - 18) < 1.5, r["br_bpm"]
assert abs(r["hr_bpm"] - 69) < 3, r["hr_bpm"]
assert r["hr_q"] > 0.5, r["hr_q"]
assert r["snr_db"] > v.SNR_MIN_DB, r["snr_db"]
H[:, b, :] -= 2000 * np.exp(1j * 4 * np.pi * d / v.WAVELENGTH)[:, None]  # nobody there
assert v.analyze(H, 0.3, 1.5)["snr_db"] < 15
H[:, b, :] += 2000  # a chair: strong, but it does not breathe
r = v.analyze(H, 0.3, 1.5)
assert r["snr_db"] > v.SNR_MIN_DB and r["span_mm"] < 0.2, (r["snr_db"], r["span_mm"])

# --- breathing: 15 a minute (3 mm) for 60 s, then 7.5 a minute (6 mm); a reflector 3 bins further is stronger but only wanders
import breathing as br

t = np.arange(int(120 * v.FRAME_HZ)) / v.FRAME_HZ
f = np.where(t < 60, 0.25, 0.125)
d = np.where(t < 60, 1.5e-3, 3e-3) * np.sin(2 * np.pi * np.cumsum(f) / v.FRAME_HZ) + 0.1e-3 * np.sin(2 * np.pi * 1.15 * t)
shape = (len(t), v.N_SAMPLES, v.N_ANT)
H = 5 * (rng.standard_normal(shape) + 1j * rng.standard_normal(shape))
H[:, b, :] += 1500 * np.exp(1j * 4 * np.pi * d / v.WAVELENGTH)[:, None]
H[:, b + 3, :] += 4000 * np.exp(1j * 4 * np.pi * 2e-3 * np.cumsum(rng.standard_normal(len(t))) / 40 / v.WAVELENGTH)[:, None]
tracker = br.Breathing(v.FRAME_HZ, v.WAVELENGTH / (4 * np.pi) * 1e3, np.arange(v.N_SAMPLES) * v.RANGE_RES, 0.3, 1.5)
hop, look = int(2 * v.FRAME_HZ), int(br.SELECT_S * v.FRAME_HZ)
seen = {}
for end in range(int(20 * v.FRAME_HZ), len(t) + 1, hop):
    seen[end / v.FRAME_HZ] = tracker.update(H[max(end - look, 0) : end], hop)
r = seen[50.0]
assert abs(r["br_period_s"] - 4.0) < 0.3 and abs(r["br_depth_mm"] - 3.0) < 0.6, (r["br_period_s"], r["br_depth_mm"])
assert abs(r["br_range_m"] - 0.6) < v.RANGE_RES, r["br_range_m"]  # the chest, not the stronger reflector
assert all(abs(p - 4.0) < 0.4 for _, p, _ in r["breaths"]), r["breaths"]
assert abs(r["hr_bpm"] - 69) < 3 and r["hr_q"] > 0.35, (r["hr_bpm"], r["hr_q"])  # the 0.1 mm heartbeat, from the same track
r = seen[110.0]
assert abs(r["br_period_s"] - 8.0) < 0.6 and abs(r["br_depth_mm"] - 6.0) < 1.2, (r["br_period_s"], r["br_depth_mm"])

# --- from behind: a back moving 1 mm (15 a minute) in front of a chair back that reflects 4x as strongly, same bin
import breathing as br2

t = np.arange(int(60 * v.FRAME_HZ)) / v.FRAME_HZ
d = 0.5e-3 * np.sin(2 * np.pi * 0.25 * t)
shape = (len(t), v.N_SAMPLES, v.N_ANT)
back = 5 * (rng.standard_normal(shape) + 1j * rng.standard_normal(shape))
back[:, b, :] += 500 * np.exp(1j * 4 * np.pi * d / v.WAVELENGTH)[:, None] + 2000 * np.exp(0.7j)
tr = br2.Breathing(v.FRAME_HZ, v.WAVELENGTH / (4 * np.pi) * 1e3, np.arange(v.N_SAMPLES) * v.RANGE_RES, 0.3, 1.5)
for end in range(int(20 * v.FRAME_HZ), len(t) + 1, hop):
    r = tr.update(back[max(end - look, 0) : end], hop)
assert abs(r["br_period_s"] - 4.0) < 0.3 and abs(r["br_depth_mm"] - 1.0) < 0.2, (r["br_period_s"], r["br_depth_mm"])
z = back[:, b, 0]
assert abs(np.ptp(np.unwrap(np.angle(z))) * v.WAVELENGTH / (4 * np.pi) * 1e3 - 1.0) > 0.5  # without the subtraction the swing is far off
z0 = 300 * np.exp(1j * 4 * np.pi * 3e-3 * np.sin(2 * np.pi * 0.25 * t[:1200]) / v.WAVELENGTH) + 20  # chest from the front: static part weaker
assert br2.remove_static(z0) is z0  # left alone

# --- breathing first: a heart-band peak on a breathing harmonic is not a heart rate
fs = v.FRAME_HZ
ts = np.arange(int(20 * fs)) / fs
harmonic = 2 * np.pi * 1.0 * 0.3 * np.cos(2 * np.pi * 1.0 * ts)  # velocity of a 0.3 mm wobble at 1.0 Hz = 4th harmonic of a 4 s breath
assert abs(br.heart_rate(harmonic, fs)[0] - 60) < 2
assert br.heart_rate(harmonic, fs, breath_s=4.0)[0] is None
assert abs(br.heart_rate(harmonic, fs, prev=61, breath_s=4.0)[0] - 60) < 2  # it was the heart rate a moment ago: it stays
beat = harmonic + 2 * np.pi * 1.2 * 0.1 * np.cos(2 * np.pi * 1.2 * ts)  # plus a weaker real heartbeat at 72
assert br.heart_rate(beat, fs, breath_s=4.0)[0] is None  # nothing says which one is the heart
assert abs(br.heart_rate(beat, fs, prev=74, breath_s=4.0)[0] - 72) < 2  # the last value does

# --- cutting breaths: a wave that never returns to zero; a deep breath with a ripple in its pause; heartbeat-sized ripple alone
t = np.arange(int(60 * v.FRAME_HZ)) / v.FRAME_HZ
cut = lambda x: [(e - a) / v.FRAME_HZ for a, e, _ in br.cut_breaths(x, v.FRAME_HZ)]
lifted = cut(np.sin(2 * np.pi * t / 3) + 3 + 2 * np.sin(2 * np.pi * t / 40))
assert len(lifted) >= 18 and all(abs(p - 3) < 0.3 for p in lifted), lifted
deep = cut(4 * np.clip(np.sin(2 * np.pi * t / 9), -0.3, 1) + 0.3 * np.sin(2 * np.pi * t / 1.5))
assert len(deep) >= 5 and all(abs(p - 9) < 1 for p in deep), deep
assert cut(0.1 * np.sin(2 * np.pi * t / 1.0)) == []

# --- chest strap: Heart Rate Measurement packets (8-bit and 16-bit rate, with and without energy field)
import strap

assert strap.parse(bytes([0x10, 60, 0x00, 0x04, 0x00, 0x02])) == (60, [1000.0, 500.0])
assert strap.parse(bytes([0x19, 0x2C, 0x01, 9, 9, 0x00, 0x04])) == (300, [1000.0])
assert strap.parse(bytes([0x00, 72])) == (72, [])

print("ok")
