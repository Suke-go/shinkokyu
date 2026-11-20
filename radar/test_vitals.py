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
assert r["present"] and r["snr_db"] > v.SNR_MIN_DB, r["snr_db"]
H[:, b, :] -= 2000 * np.exp(1j * 4 * np.pi * d / v.WAVELENGTH)[:, None]  # nobody there
r = v.analyze(H, 0.3, 1.5)
assert not r["present"] and r["snr_db"] < 15, r["snr_db"]
H[:, b, :] += 2000  # a chair: strong, but it does not breathe
r = v.analyze(H, 0.3, 1.5)
assert not r["present"] and r["snr_db"] > v.SNR_MIN_DB and r["span_mm"] < 0.2, (r["snr_db"], r["span_mm"])

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

# --- chest strap: Heart Rate Measurement packets (8-bit and 16-bit rate, with and without energy field)
import strap

assert strap.parse(bytes([0x10, 60, 0x00, 0x04, 0x00, 0x02])) == (60, [1000.0, 500.0])
assert strap.parse(bytes([0x19, 0x2C, 0x01, 9, 9, 0x00, 0x04])) == (300, [1000.0])
assert strap.parse(bytes([0x00, 72])) == (72, [])

print("ok")
