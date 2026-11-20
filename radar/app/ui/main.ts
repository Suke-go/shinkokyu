type Status = { state: string; text?: string; progress?: number };
type Live = {
  quality: number; // 0-3: the bars
  quality_why: string; // what the quality rests on: see WHY
  hr_bpm: number | null;
  hr_q: number;
  wave: number[]; // the tracker's breathing wave of the last 30 s; only its length is used here
  cuts: number[]; // indices into `wave` where a breath starts or ends
};
type Wave = { y: number[] }; // the chest's displacement as it happens, mm, drift included, one value per radar frame
type Seen = { db: number[] };
type Stopped = { error: string | null };
type Win = { once(event: string, fn: () => void): void; setFocus(): Promise<void> };

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(cmd: string): Promise<T> };
      event: { listen<T>(name: string, fn: (e: { payload: T }) => void): Promise<unknown> };
      webviewWindow: { WebviewWindow: { new (label: string, options: object): Win; getByLabel(label: string): Promise<Win | null> } };
    };
  }
}
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;

// One line under the bars: what the radar sees, and what is missing for three bars.
const WHY: Record<string, string> = {
  empty: "何も映っていません。レーダーを体に向けてください",
  static: "物は映っていますが、呼吸の動きがありません",
  moving: "呼吸が見えています。体が動いています",
  few: "呼吸が見えています。あと少しそのままで",
  steady: "安定しています。課題を始められます",
};
const FRAME_HZ = 40, SPAN_MS = 30000; // radar frames a second; how much of the past the line shows

const el = (id: string) => document.getElementById(id)!;
const hr = el("hr"), br = el("br"), per = el("per"), note = el("note"), why = el("why"), toggle = el("toggle");
const canvas = el("trace") as HTMLCanvasElement, strip = el("seen") as HTMLCanvasElement;
const setState = (s: string) => { document.body.dataset.state = s; };
const setQuality = (q: number, reason: string) => {
  document.body.dataset.quality = String(q);
  why.textContent = WHY[reason] ?? "";
};
const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name);
let seen: number[] = [];
let mine = false; // this window started the measurement (a typing session starts its own)
let estimating = false; // "live" has started: it decides the quality from here on

// The moving line: chest displacement sample by sample (`d` as measured, `y` as drawn), and the breath boundaries
// the tracker found, both by clock time.
let points: { t: number; d: number; y: number }[] = [];
let marks: number[] = [];
let lo = -1, hi = 1; // vertical range, eased so the line does not jump when it rescales
let frameId = 0;

// Minutes of resting breathing the typing task measures before it starts; 0 = none. The task window reads it.
const mins = el("mins");
let minutes = 3;
try { minutes = Number(localStorage.getItem("baselineMinutes") ?? 3); } catch { /* storage unavailable */ }
function setMinutes(m: number) {
  minutes = Math.min(Math.max(Math.round(m) || 0, 0), 10);
  mins.textContent = String(minutes);
  try { localStorage.setItem("baselineMinutes", String(minutes)); } catch { /* storage unavailable */ }
}
setMinutes(minutes);
el("less").onclick = () => setMinutes(minutes - 1);
el("more").onclick = () => setMinutes(minutes + 1);

// Gaussian smoothing in three running-mean passes, edges mirrored. sigma in samples.
function gauss(a: number[], sigma: number): number[] {
  const n = a.length, r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  for (let pass = 0; pass < 3; pass++) {
    const at = (i: number) => a[i < 0 ? Math.min(-i, n - 1) : i >= n ? Math.max(2 * (n - 1) - i, 0) : i];
    const out = new Array<number>(n);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < n; i++) {
      out[i] = sum / (2 * r + 1);
      sum += at(i + r + 1) - at(i - r);
    }
    a = out;
  }
  return a;
}

// What is drawn is what is analysed: the displacement smoothed (noise and heartbeat out) minus a wide Gaussian of
// itself (the level the body sits at, which wanders as posture settles). The newest second is provisional.
function level() {
  const smooth = gauss(points.map((p) => p.d), 0.35 * FRAME_HZ);
  const base = gauss(smooth, 2.5 * FRAME_HZ);
  points.forEach((p, i) => { p.y = smooth[i] - base[i]; });
}

function show(box: HTMLElement, value: number | null, trusted: boolean) {
  box.querySelector("output")!.textContent = value == null ? "–" : String(Math.round(value));
  box.classList.toggle("weak", !trusted);
}

function fit() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
}
new ResizeObserver(fit).observe(canvas);

function draw() {
  frameId = requestAnimationFrame(draw);
  const now = performance.now(), dpr = window.devicePixelRatio || 1;
  const { width: w, height: h } = canvas;
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  marks = marks.filter((m) => now - m <= SPAN_MS);
  if (points.length < 2) return;
  const x = (t: number) => w - ((now - t) / SPAN_MS) * w; // now is at the right edge; the past moves left
  g.lineWidth = dpr;
  g.strokeStyle = css("--soft");
  for (const m of marks) {
    g.beginPath();
    g.moveTo(x(m), 0);
    g.lineTo(x(m), h);
    g.stroke();
  }
  let min = Infinity, max = -Infinity;
  for (const p of points) { min = Math.min(min, p.y); max = Math.max(max, p.y); }
  const pad = Math.max(2 - (max - min), 0) / 2; // at least 2 mm tall, so noise does not fill the view
  lo += (min - pad - lo) * 0.08;
  hi += (max + pad - hi) * 0.08;
  g.beginPath();
  for (const p of points) g.lineTo(x(p.t), h * 0.95 - ((p.y - lo) / (hi - lo)) * h * 0.9);
  g.lineWidth = 1.5 * dpr;
  g.lineJoin = "round";
  g.strokeStyle = css(Number(document.body.dataset.quality) >= 2 ? "--ink" : "--soft"); // dark once a breathing person is followed
  g.stroke();
}

function drawSeen() {
  const w = (strip.width = strip.clientWidth), h = (strip.height = strip.clientHeight);
  const g = strip.getContext("2d")!;
  seen.forEach((db, i) => {
    g.fillStyle = `rgba(34, 34, 34, ${Math.min(Math.max((db - 10) / 30, 0), 1)})`; // 10 dB over the floor = blank, 40 dB = black
    g.fillRect((i * w) / seen.length, 0, Math.ceil(w / seen.length), h);
  });
}
new ResizeObserver(drawSeen).observe(strip);

function reset() {
  mine = estimating = false;
  setState("idle");
  setQuality(0, "");
  toggle.setAttribute("aria-label", "測定開始");
  toggle.style.removeProperty("--p");
  show(br, null, true);
  show(hr, null, true);
  per.textContent = "";
  points = [];
  marks = [];
  seen = [];
  cancelAnimationFrame(frameId);
  frameId = 0;
  canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  drawSeen();
}

toggle.onclick = async () => {
  try {
    if (document.body.dataset.state === "idle") {
      note.textContent = "";
      await invoke("start");
      mine = true;
      toggle.setAttribute("aria-label", "測定停止");
      setState("connecting");
    } else if (mine) {
      await invoke("stop");
      setState("stopping");
    }
  } catch (e) {
    note.textContent = String(e);
  }
};

// The typing task opens in its own window; closing it comes back here.
el("task").onclick = () => {
  const w = new WebviewWindow("task", { url: "site/experiment/", title: "転記タイピング実験", width: 1280, height: 820 });
  w.once("tauri://error", async () => (await WebviewWindow.getByLabel("task"))?.setFocus()); // already open
};

listen<Status>("status", ({ payload: s }) => {
  if (document.body.dataset.state !== "stopping") setState(s.state);
  if (s.progress != null) toggle.style.setProperty("--p", String(s.progress));
  if (s.state !== "collecting") estimating = false;
  note.textContent = s.state === "retry" ? (s.text ?? "") : "";
});

listen<Seen>("seen", ({ payload }) => {
  seen = payload.db;
  drawSeen();
  // before the first estimate, the reflection alone gives the first bar
  if (!estimating) Math.max(...seen) >= 16 ? setQuality(1, "") : setQuality(0, "empty");
});

listen<Wave>("wave", ({ payload }) => {
  const now = performance.now(), n = payload.y.length;
  payload.y.forEach((d, i) => points.push({ t: now - ((n - 1 - i) * 1000) / FRAME_HZ, d, y: 0 }));
  while (points.length && now - points[0].t > SPAN_MS + 5000) points.shift(); // 5 s more than shown, so the left edge is settled
  level();
  if (!frameId) draw();
});

listen<Live>("live", ({ payload: e }) => {
  if (document.body.dataset.state !== "stopping") setState("streaming");
  estimating = true;
  setQuality(e.quality, e.quality_why);
  // The breathing number is the breaths marked on the line: the median length of those cut in the last 30 s,
  // as breaths a minute and as seconds a breath. Without a person there are no numbers at all.
  const cuts = e.cuts.slice(e.cuts.length % 2); // pairs of start, end; a breath that began before the wave has only its end
  const lengths = cuts.flatMap((c, i) => (i % 2 ? [(c - cuts[i - 1]) / FRAME_HZ] : [])).sort((a, b) => a - b);
  const breath = e.quality >= 2 && lengths.length ? (lengths[(lengths.length - 1) >> 1] + lengths[lengths.length >> 1]) / 2 : null;
  show(br, breath && 60 / breath, e.quality >= 3);
  per.textContent = breath ? `1 呼吸 ${breath.toFixed(1)} 秒` : "";
  show(hr, e.quality >= 2 ? e.hr_bpm : null, e.hr_q >= 0.35);
  const now = performance.now();
  marks = e.quality >= 2 ? e.cuts.map((c) => now - ((e.wave.length - c) * 1000) / FRAME_HZ) : [];
});

listen<Stopped>("stopped", ({ payload }) => {
  reset();
  note.textContent = payload.error ?? "";
});

export {};
