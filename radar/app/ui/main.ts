type Status = { state: string; text?: string; progress?: number };
type Live = {
  quality: number; // 0-3, see the bars in index.html
  br_bpm: number | null;
  hr_bpm: number | null;
  hr_q: number;
  wave: number[]; // breathing wave of the last 30 s, mm
  cuts: number[]; // indices into `wave` where a breath starts or ends
  baseline?: { have_s: number; need_s: number }; // how far the baseline has run
};
type Baseline = { br_bpm: number | null; hr_bpm: number | null; steady_share: number };
type Seen = { db: number[] };
type Stopped = { error: string | null };
type Win = { once(event: string, fn: () => void): void; setFocus(): Promise<void> };

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(cmd: string, args?: object): Promise<T> };
      event: { listen<T>(name: string, fn: (e: { payload: T }) => void): Promise<unknown> };
      webviewWindow: { WebviewWindow: { new (label: string, options: object): Win; getByLabel(label: string): Promise<Win | null> } };
    };
  }
}
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { WebviewWindow } = window.__TAURI__.webviewWindow;

const el = (id: string) => document.getElementById(id)!;
const hr = el("hr"), br = el("br"), note = el("note"), toggle = el("toggle");
const canvas = el("trace") as HTMLCanvasElement, strip = el("seen") as HTMLCanvasElement;
const setState = (s: string) => { document.body.dataset.state = s; };
const setQuality = (q: number) => { document.body.dataset.quality = String(q); };
const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name);
let trace: number[] = [], cuts: number[] = [], seen: number[] = [];
let mine = false; // this window started the measurement (a typing session starts its own)
let estimating = false; // "live" has started: it decides the quality from here on

// Baseline length in minutes; 0 = measure until stopped. Remembered between runs.
const mins = el("mins");
let minutes = 3;
try { minutes = Number(localStorage.getItem("baselineMinutes") ?? 3); } catch { /* storage unavailable */ }
function setMinutes(m: number) {
  minutes = Math.min(Math.max(Math.round(m) || 0, 0), 10);
  mins.textContent = minutes ? String(minutes) : "∞";
  try { localStorage.setItem("baselineMinutes", String(minutes)); } catch { /* storage unavailable */ }
}
setMinutes(minutes);
el("less").onclick = () => setMinutes(minutes - 1);
el("more").onclick = () => setMinutes(minutes + 1);

function show(box: HTMLElement, value: number | null, trusted: boolean) {
  box.querySelector("output")!.textContent = value == null ? "–" : String(Math.round(value));
  box.classList.toggle("weak", !trusted);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = canvas.clientWidth * dpr), h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  if (trace.length < 2) return;
  const x = (i: number) => (i / (trace.length - 1)) * w;
  g.lineWidth = dpr;
  g.strokeStyle = css("--soft");
  for (const c of cuts) {
    g.beginPath();
    g.moveTo(x(c), 0);
    g.lineTo(x(c), h);
    g.stroke();
  }
  const lo = Math.min(...trace), hi = Math.max(...trace);
  const mid = (lo + hi) / 2, span = Math.max(hi - lo, 2); // at least 2 mm tall, so noise does not fill the view
  g.beginPath();
  trace.forEach((v, i) => g.lineTo(x(i), h / 2 - ((v - mid) / span) * h * 0.9));
  g.lineWidth = 1.5 * dpr;
  g.lineJoin = "round";
  g.strokeStyle = css("--mid");
  g.stroke();
}
new ResizeObserver(draw).observe(canvas);

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
  delete document.body.dataset.done;
  setState("idle");
  setQuality(0);
  toggle.setAttribute("aria-label", "測定開始");
  toggle.style.removeProperty("--p");
  show(br, null, true);
  show(hr, null, true);
  trace = cuts = seen = [];
  draw();
  drawSeen();
}

toggle.onclick = async () => {
  try {
    if (document.body.dataset.state === "idle") {
      reset(); // clears a finished baseline off the screen
      note.textContent = "";
      await invoke("start", minutes ? { baselineS: minutes * 60 } : undefined);
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
  if (!estimating) setQuality(Math.max(...seen) >= 26 ? 1 : 0);
});

listen<Live>("live", ({ payload: e }) => {
  if (document.body.dataset.state !== "stopping") setState("streaming");
  estimating = true;
  setQuality(e.quality);
  // without a person there are no numbers at all, rather than numbers made from noise
  show(br, e.quality >= 2 ? e.br_bpm : null, e.quality >= 3);
  show(hr, e.quality >= 2 ? e.hr_bpm : null, e.hr_q >= 0.35);
  trace = e.quality >= 2 ? e.wave : [];
  cuts = e.quality >= 2 ? e.cuts : [];
  draw();
  if (e.baseline) toggle.style.setProperty("--p", String(Math.min(e.baseline.have_s / e.baseline.need_s, 1))); // the ring is the baseline's progress
});

// A baseline finished: it stops by itself and its result stays on the screen.
listen<Baseline>("baseline", ({ payload: b }) => {
  document.body.dataset.done = "1";
  // pale if the breathing was steady for less than half of the baseline: better taken again
  show(br, b.br_bpm, b.steady_share >= 0.5);
  show(hr, b.hr_bpm, b.steady_share >= 0.5);
});

listen<Stopped>("stopped", ({ payload }) => {
  if (document.body.dataset.done) {
    mine = estimating = false;
    setState("idle");
  } else reset();
  note.textContent = payload.error ?? "";
});

export {};
