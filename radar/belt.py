"""Log a breathing belt (a strain gauge on an Arduino's A0): the reference the radar's breaths are checked against.

    python radar/belt.py            # until Ctrl+C, into radar/captures/belt_<UTC stamp>.belt.csv
    python radar/vitals.py --belt   # the same alongside a radar capture, as radar_<UTC stamp>.belt.csv

The Arduino prints "time_s,raw_value,..." lines at 115200 baud, 50 a second. Each is saved as "t,time_s,raw":
local ms on arrival (the clock of the radar's frames), the Arduino's own clock, and A0 (0-1023).
Opening the port restarts the Arduino, so time_s starts again from zero.
"""
import sys
import time
from pathlib import Path

import serial
from serial.tools import list_ports

from vitals import now_ms

ARDUINO_VID = 0x2341


def log(path, port=None):
    with open(path, "a") as f:
        if not f.tell():
            f.write("t,time_s,raw\n")
        while True:  # a knock on the USB cable drops the link: reopen and carry on
            try:
                dev = port or next((p.device for p in list_ports.comports() if p.vid == ARDUINO_VID), None)
                if not dev:
                    raise serial.SerialException("no Arduino found; give its port as the second argument")
                with serial.Serial(dev, 115200, timeout=1) as s:
                    print(f"belt: {dev}, logging to {path}", flush=True)
                    while True:
                        cells = s.readline().decode("ascii", "replace").strip().split(",")
                        if len(cells) >= 2 and cells[1].isdigit():  # not the header, not a line cut by the restart
                            f.write(f"{now_ms():.1f},{cells[0]},{cells[1]}\n")
                            f.flush()
            except serial.SerialException as e:
                print(f"belt: {e}; retrying...", flush=True)
                time.sleep(1)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "captures" / time.strftime("belt_%Y%m%d-%H%M%S.belt.csv", time.gmtime())
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        log(out, sys.argv[2] if len(sys.argv) > 2 else None)
    except KeyboardInterrupt:
        pass
