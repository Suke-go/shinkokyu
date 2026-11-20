type Status = { state: string; text?: string; progress?: number };
type Live = {
  quality: number; // 0-3, see the bars in index.html
  br_bpm: number | null;
  hr_bpm: number | null;
  hr_q: number;
  wave: number[]; // breathing wave of the last 30 s, mm
  cuts: number[]; // indices into `wave` where a breath starts or ends
};
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

const el = (id: string) => document.getElementById(id)!;
const hr = el("hr"), br = el("br"), note = el("note"), toggle = el("toggle");
const canvas = el("trace") as HTMLCanvasElement, strip = el("seen") as HTMLCanvasElement;
const setState = (s: string) => { document.body.dataset.state = s; };
const setQuality = (q: number) => { document.body.dataset.quality = String(q); };
const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name);
let trace: number[] = [], cuts: number[] = [], seen: number[] = [];
let mine = false; // this window started the measurement (a typing session starts its own)
let estimating = false; // "live" has started: it decides the quality from here on

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

// The typing task and the dashboard open in their own windows; closing one comes back here.
function open(label: string, url: string, title: string) {
  const w = new WebviewWindow(label, { url, title, width: 1280, height: 820 });
  w.once("tauri://error", async () => (await WebviewWindow.getByLabel(label))?.setFocus()); // already open
}
el("task").onclick = () => open("task", "site/experiment/", "転記タイピング実験");
el("dash").onclick = () => open("dash", "site/dashboard/", "ダッシュボード");

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
});

listen<Stopped>("stopped", ({ payload }) => {
  reset();
  note.textContent = payload.error ?? "";
});

export {};
