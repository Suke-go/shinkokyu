type Status = { state: string; text?: string; progress?: number };
type Estimate = { present: boolean; hr_bpm: number | null; hr_q: number | null; br_bpm: number | null; disp: number[] };
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
const canvas = el("trace") as HTMLCanvasElement;
const setState = (s: string) => { document.body.dataset.state = s; };
const strip = el("seen") as HTMLCanvasElement;
let trace: number[] = [];
let seen: number[] = [];
let mine = false; // this window started the measurement (a typing session starts its own)

function show(box: HTMLElement, value: number | null, trusted: boolean) {
  box.querySelector("output")!.textContent = value == null ? "–" : String(Math.round(value));
  box.classList.toggle("weak", !trusted);
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  if (trace.length < 2) return;
  const lo = Math.min(...trace), hi = Math.max(...trace);
  const mid = (lo + hi) / 2, span = Math.max(hi - lo, 2); // at least 2 mm tall, so noise does not fill the view
  g.beginPath();
  trace.forEach((v, i) => g.lineTo((i / (trace.length - 1)) * w, h / 2 - ((v - mid) / span) * h * 0.9));
  g.lineWidth = 1.5 * dpr;
  g.lineJoin = "round";
  g.strokeStyle = getComputedStyle(document.body).getPropertyValue("--mid");
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
  mine = false;
  setState("idle");
  toggle.setAttribute("aria-label", "測定開始");
  toggle.style.removeProperty("--p");
  show(hr, null, true);
  show(br, null, true);
  trace = [];
  seen = [];
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
  note.textContent = s.state === "retry" ? (s.text ?? "") : "";
});

listen<Estimate>("estimate", ({ payload: e }) => {
  if (document.body.dataset.state !== "stopping") setState("streaming");
  // nothing in the beam: no numbers at all, rather than numbers made from noise
  show(hr, e.present ? e.hr_bpm : null, (e.hr_q ?? 0) >= 0.35);
  show(br, e.present ? e.br_bpm : null, true);
  if (e.hr_bpm) (hr.querySelector("svg") as SVGElement).style.animationDuration = `${60 / e.hr_bpm}s`;
  trace = e.present ? e.disp : [];
  draw();
});

listen<Seen>("seen", ({ payload }) => {
  seen = payload.db;
  drawSeen();
});

listen<Stopped>("stopped", ({ payload }) => {
  reset();
  note.textContent = payload.error ?? "";
});

export {};
