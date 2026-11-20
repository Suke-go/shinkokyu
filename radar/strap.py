"""Log beat-to-beat intervals from a Bluetooth chest strap: the reference the radar is checked against.

    python radar/strap.py            # until Ctrl+C, into radar/captures/strap_<UTC stamp>.rr.jsonl
    python radar/vitals.py --strap   # the same alongside a radar capture, as radar_<UTC stamp>.rr.jsonl

Any strap with the standard Bluetooth Heart Rate service works (Polar H9/H10, Garmin HRM-Dual,
Wahoo TICKR, ...). Wear it first (it only switches on against skin) and disconnect it from phone apps.

One line per notification (about one a second): {"t": local ms on arrival, "hr": bpm, "rr": [ms, ...]}.
The intervals are the strap's own measurement (1/1024 s steps); "t" lags the beats by up to a second.
"""
import asyncio
import json
import sys
import time
from pathlib import Path

from bleak import BleakClient, BleakScanner

from vitals import now_ms

HR_SERVICE = "0000180d-0000-1000-8000-00805f9b34fb"
HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"


def parse(data):
    """Heart Rate Measurement characteristic -> (bpm, [RR intervals in ms])."""
    flags = data[0]
    bpm, i = (int.from_bytes(data[1:3], "little"), 3) if flags & 1 else (data[1], 2)
    if flags & 8:  # energy expended
        i += 2
    rr = [int.from_bytes(data[j : j + 2], "little") * 1000 / 1024 for j in range(i, len(data) - 1, 2)] if flags & 16 else []
    return bpm, rr


async def log(path):
    with open(path, "a") as f:
        def on_measurement(_, data):
            bpm, rr = parse(data)
            f.write(json.dumps({"t": now_ms(), "hr": bpm, "rr": rr}) + "\n")
            f.flush()

        while True:  # the strap drops out when it loses skin contact: keep coming back
            print("strap: looking for a heart-rate strap...", flush=True)
            dev = await BleakScanner.find_device_by_filter(lambda d, adv: HR_SERVICE in [u.lower() for u in adv.service_uuids], timeout=30)
            if not dev:
                print("strap: none found. Is Bluetooth on, the strap worn, and no phone app connected to it?", flush=True)
                continue
            try:
                async with BleakClient(dev) as client:
                    await client.start_notify(HR_MEASUREMENT, on_measurement)
                    print(f"strap: {dev.name} connected, logging to {path}", flush=True)
                    while client.is_connected:
                        await asyncio.sleep(1)
            except Exception as e:  # bleak raises backend-specific errors on a lost link
                print(f"strap: {e!r}", flush=True)
            print("strap: disconnected", flush=True)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "captures" / time.strftime("strap_%Y%m%d-%H%M%S.rr.jsonl", time.gmtime())
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        asyncio.run(log(out))
    except KeyboardInterrupt:
        pass
