type Status = { state: string; text?: string; progress?: number };
type Estimate = { hr_bpm: number | null; hr_q: number | null; br_bpm: number | null; span_mm: number | null; disp: number[] };
type Stopped = { error: string | null };

declare global {
  interface Window {
    __TAURI__: {
      core: { invoke<T>(cmd: string): Promise<T> };
      event: { listen<T>(name: string, fn: (e: { payload: T }) => void): Promise<unknown> };
    };
  }
}
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id: string) => document.getElementById(id)!;
const hr = el("hr"), br = el("br"), note = el("note"), toggle = el("toggle");
const canvas = el("trace") as HTMLCanvasElement;
const setState = (s: string) => { document.body.dataset.state = s; };
let trace: number[] = [];

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

function reset() {
  setState("idle");
  toggle.setAttribute("aria-label", "計測開始");
  toggle.style.removeProperty("--p");
  show(hr, null, true);
  show(br, null, true);
  trace = [];
  draw();
}

toggle.onclick = async () => {
  try {
    if (document.body.dataset.state === "idle") {
      note.textContent = "";
      toggle.title = await invoke<string>("start"); // where the files go
      toggle.setAttribute("aria-label", "計測停止");
      setState("sync");
    } else {
      await invoke("stop");
      setState("stopping");
    }
  } catch (e) {
    note.textContent = String(e);
  }
};

listen<Status>("status", ({ payload: s }) => {
  if (document.body.dataset.state !== "stopping") setState(s.state);
  if (s.progress != null) toggle.style.setProperty("--p", String(s.progress));
  note.textContent = s.state === "retry" || s.state === "sync" ? (s.text ?? "") : "";
});

listen<Estimate>("estimate", ({ payload: e }) => {
  if (document.body.dataset.state !== "stopping") setState("streaming");
  const present = (e.span_mm ?? 0) >= 0.2; // someone is in front of the radar
  show(hr, e.hr_bpm, present && (e.hr_q ?? 0) >= 0.35);
  show(br, e.br_bpm, present);
  if (e.hr_bpm) (hr.querySelector("svg") as SVGElement).style.animationDuration = `${60 / e.hr_bpm}s`;
  trace = e.disp;
  draw();
});

listen<Stopped>("stopped", ({ payload }) => {
  reset();
  note.textContent = payload.error ?? "";
});

export {};
