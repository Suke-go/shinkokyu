# 転記タイピング実験システム — SPEC (single source of truth)

方針: ponytail (最小で完結)。**npm 依存ゼロ**。Node 24 標準ライブラリ + 素の HTML/CSS/ES Modules。ビルド無し。

## 0. 構成（3モジュール分離: 実験 / ストレージ / ビュー）

```
shinkokyu/
  SPEC.md
  docs/survey/*.md            サーベイ結果
  server/                     ストレージ + 時刻 (Node, 依存ゼロ)
    server.js                 起動: node server/server.js  → http://localhost:8787
    sntp.js                   NTPサーバとのSNTP同期 (node:dgram)
    experiments.json          実験ID → 課題文 の設定
    test.js                   node server/test.js (assertベースの自己チェック)
  data/                       ログ保存先 (gitignore相当, 自動作成)
    <sessionId>.json          セッションメタ
    <sessionId>.events.jsonl  イベント (1行1JSON, 追記)
  public/
    shared/
      tokens.css              デザイントークン（全画面共通）
      clock.js                ブラウザ側時刻同期 (export)
      metrics.js              指標計算 (export, ダッシュボードが使用。純関数)
    experiment/index.html, app.js, style.css    実験 (被験者用)
    dashboard/index.html, app.js, style.css     ビュー (研究者用)
```

URL: 実験 `http://localhost:8787/experiment/` / ダッシュボード `http://localhost:8787/dashboard/`

## 1. HTTP API（server が提供。JSON。CORS 不要: 同一オリジン）

| Method | Path | 入力 | 出力 |
|---|---|---|---|
| GET | `/api/time` | – | `{ "t1": <server recv UTC ms>, "t2": <server send UTC ms> }` ※ UTC ms = `Date.now() + sntpOffset`。t1 はリクエスト受信直後、t2 はレスポンス書き込み直前に取得。`performance.now()` ベースで小数ms可 |
| GET | `/api/server-clock` | – | `{ "sntp": { "ok": bool, "offset": ms, "delay": ms, "server": "...", "at": UTC ms } }` |
| GET | `/api/experiments/:expId` | – | `{ "expId", "title", "lang", "text" }` 404 if unknown |
| POST | `/api/sessions` | `{ "expId", "participantId" }` | `{ "sessionId" }` sessionId = `${expId}_${participantId}_${YYYYMMDD-HHmmss}` (英数と`-_`のみに正規化) |
| POST | `/api/sessions/:id/sync` | 同期結果オブジェクト (§3) | `{ "ok": true }` meta.syncs 配列に追記 |
| POST | `/api/sessions/:id/events` | `{ "seq": <batch番号>, "events": [ ... ] }` | `{ "ok": true, "seq" }` 同じ seq の再送は無視 (冪等) |
| POST | `/api/sessions/:id/finish` | `{ "finalText", "endedAt" }` | `{ "ok": true }` |
| GET | `/api/sessions` | – | `[{ sessionId, expId, participantId, startedAt, endedAt, eventCount }]` 新しい順 |
| GET | `/api/sessions/:id` | – | `{ meta, events: [...] }` |

- 入力検証（信頼境界）: expId / participantId は `^[A-Za-z0-9_-]{1,64}$`、body 上限 5MB、:id はパストラバーサル不可（同じ正規表現 + 存在確認）。不正は 400。
- 静的配信: `/` → `/experiment/` へリダイレクト。`public/` 配下のみ配信、`..` 拒否。Content-Type は拡張子から (html/js/css/json/svg)。

## 2. セッションメタ `data/<id>.json`

```json
{ "sessionId": "...", "expId": "...", "participantId": "...",
  "createdAt": <UTC ms>, "startedAt": <UTC ms|null>, "endedAt": <UTC ms|null>,
  "sourceText": "...", "finalText": null, "userAgent": "...",
  "serverSntp": { ...§1 server-clock の sntp },
  "syncs": [ <§3 同期結果>, ... ] }
```

## 3. 時刻同期（根拠: docs/survey/clock-sync.md — enmasseio/timesync, hapijs/sntp を参照）

2段構成。**イベント時刻は生のまま保存し、補正は解析時（オフライン）**。

**A. server → UTC（server/sntp.js）**: SNTP over `node:dgram`。`time.google.com`（失敗時 `pool.ntp.org`、1回の同期内でホストは混ぜない）。
8サンプル・300ms間隔・timeout 1s・最初の1つを捨てる。delta<0 / delta>500 / 不正パケット（mode≠4, stratum=0, LI=3, originate 不一致）は棄却。
offset = 最小 delta サンプルの theta。median theta も保存。起動時 + 10分毎。全失敗時は offset=0, ok=false でサーバは動き続ける（ログに警告）。
サーバ時計: `serverNow() = performance.timeOrigin + performance.now() + sntp.offset`。`/api/time` はこれを返す。
パケット: 48byte, byte0=0x23, transmit timestamp @40, originate @24, receive @32, NTP epoch 2208988800。

**B. browser → server（public/shared/clock.js）**: HTTP の NTP 4タイムスタンプ方式。
`t0`,`t3` = `performance.timeOrigin + performance.now()`。20サンプル・100ms間隔・逐次・最初の3つを捨てる（接続確立のペナルティ）。
`offset=((t1-t0)+(t2-t3))/2`, `delay=(t3-t0)-(t2-t1)`。採用 offset = 最小 delay サンプルの offset。
品質: `delay_min < 50ms` かつ 低delay上位5個の offset の spread < 5ms → `quality:"good"`、満たさなければ最大3回までやり直し、だめなら `quality:"bad"` で続行（実験は止めない）。
実行タイミング: **スタート押下時（phase:"start"）** と **完了時（phase:"end"）**。

```js
// clock.js の export
export async function syncClock({ phase, onProgress }) // → 同期結果 (下記) 。onProgress(i, n)
// 同期結果 = { phase, offset, delay, medianLow5, spreadLow5, n, at /*local ms (t3 of best)*/, quality, attempts,
//              samples:[{t0,t1,t2,t3,offset,delay}], timeOrigin, crossOriginIsolated, skew /*timeOrigin+now()-Date.now()*/, ua }
export function makeOffsetFn(syncs) // syncs=meta.syncs → (tLocal)=>tUtc。start と end があれば at を基準に offset を線形補間、1つなら定数、0なら恒等(+警告フラグ)
```
- clock.js は**ブラウザ・Node 両対応の純ESM**にする（makeOffsetFn はダッシュボードと Node テストで使う）。
- 精度の目安: browser→server ≤ delay_min/2、server→UTC は SNTP 誤差（ネット越し 5–30ms 程度）。

## 4. イベントスキーマ（根拠: docs/survey/keystroke-metrics.md）

1イベント = 1 JSON:
```json
{"t":1731139200123.4,"seq":57,"type":"keydown","key":"Process","code":"KeyK","isComposing":true,
 "repeat":false,"inputType":null,"data":null,"len":12,"caret":12,"selLen":0}
```
- `t`: **ローカル時刻** = `performance.timeOrigin + e.timeStamp`（小数ms）。UTC 変換は解析側で `t + offset`（§3）。Date.now() はイベント毎に使わない。
- `seq`: セッション内の通し番号（0 始まり）。
- `type`: `keydown` `keyup` `input` `compositionstart` `compositionupdate` `compositionend` `paste` `focus` `blur` `snapshot` `session_start` `session_end`
- `key`,`code`,`repeat`: keydown/keyup のみ。他は null。
- `blocked`: keydown のみ。ショートカット抑止で preventDefault した場合 true（それ以外は欠落）。
- `isComposing`: KeyboardEvent/InputEvent の値。他は false。
- `inputType`: input のみ（insertText, insertCompositionText, deleteContentBackward, insertParagraph(=Enter), insertFromPaste, historyUndo ...）
- `data`: input / composition* の `e.data`。`snapshot`・`session_start`・`session_end` では `data` にエディタ全文を入れる。
- `len`: イベント処理後のエディタ全文の文字数（`[...text].length`、コードポイント数）。`caret`: selectionStart。`selLen`: selectionEnd-selectionStart。
- リスナーは editor 要素に capture フェーズで付ける。`snapshot` は session_start 時・5 秒毎・session_end 時。
- エディタは **`<textarea>`**（contenteditable はIME/改行の扱いが不安定なため使わない。書式無しタスクなので十分）。
- paste / drop は `preventDefault()` で禁止し、`paste` イベントだけ記録する。undo(Ctrl+Z) は許可しログに残る。
- 送信: 1 秒毎にバッファをまとめて POST（§1 events, seq=バッチ番号）。未送信分は `localStorage["pending:<sessionId>"]` に保持し、成功応答で削除。失敗時は指数バックオフで再送。`beforeunload` で未送信があれば警告。

派生定義（ログしない、metrics.js で計算）:
- **commit**: `input` かつ inputType=`insertText` かつ isComposing=false → k = [...data].length / `compositionend` → k = [...data].length / `input` inputType=`insertLineBreak` または `insertParagraph`（textarea の Enter は Chrome/Firefox とも insertLineBreak）→ k=1。paste は除外。
- **correction**: inputType が `deleteContentBackward`/`deleteContentForward` かつ isComposing=false。
- **activity**: keydown（"Process" 含む、repeat 除外）・compositionupdate・input。gap = 連続 activity 間隔。

## 5. 指標（2つ） — metrics.js に純関数として実装

定数（名前付きで export、ダッシュボードで表示）: `W=10000ms, STEP=1000ms, PAUSE=2000ms, SLOW_RATIO=0.5, SLOW_MIN=5000ms, MERGE_GAP=2000ms`

グリッド: 最初の activity から最後の commit まで STEP 刻み。点 s の窓は (s-W, s]。s-W < 開始 の点は `warmup:true`（グレー表示）。

1. **速度 CPM(s)** = 60000 × Σ{k_i | commit t_i ∈ (s-W, s]} / W 。英語表示用に WPM=CPM/5 も返す。
2. **停止率 PR(s)** = (窓内で gap ≥ PAUSE の区間に入る時間) / W、0–1。gap は窓でクリップ。右端の開いた gap は s までカウント。

減速区間:
- base = CPM>0 かつ warmup でない点の CPM 中央値（最後の窓を除く）。
- CPM < SLOW_RATIO×base が SLOW_MIN 以上続く最大連続区間。MERGE_GAP 未満の隙間で隣接する区間は結合。
- 区間の平均 PR ≥ 0.5 → `"hesitation"`（迷い・停止）、それ以外 → `"slow"`（ゆっくり打鍵・変換多）。

サマリ（ダッシュボードに小さく）: 平均CPM、総時間、誤り率 = 100 × Levenshtein(P,T) / max(|P|,|T|)（NFC 正規化、改行は \n、末尾空白 trim、コードポイント単位）、訂正数。

API:
```js
export const PARAMS = {...};
export function computeTimeline(events, offsetFn) // → { points:[{t, cpm, wpm, pr, warmup, text?}], base, segments:[{t0,t1,kind,meanPr}], summary:{...} }
export function textAt(events, tUtc, offsetFn)      // 時刻 tUtc 時点のエディタ全文（直前 snapshot + 以後の input を再生、または最近傍 snapshot で可）
export function levenshtein(a, b)
```
offsetFn(tLocal) → UTC ms（§3 の補正）。

## 5.2 ダッシュボード v2 レイアウト（ユーザー指示 2026-11-09）

- 画面 = 100vh 固定・ページスクロール無し。上部バー（ブランド / セッション選択 / エクスポート / 全画面）。
- **左半分**: 速度・停止率の2レーンタイムライン（縦いっぱい）。**左下**に主要指標（速度CPM・IKI中央値・KSPC・訂正率・誤り率。ユーザー指示で「迷い」表記は廃止、帯は「停止」「低速」）。注記行は出さない（同期不良時のみ警告）。
- **右半分**: 入力の**リプレイ動画**。紙面に textAt(t) を描画し、キャレット点滅、IME 変換中の未確定文字は下線付きで表示。再生/一時停止・速度(1×/2×/4×/8×)・シークバー・現在時刻。
- **同期**: 左グラフのクリック/ドラッグ → 右のリプレイがその時刻にシーク。再生中は左グラフ上の再生位置の縦線が動く。減速帯クリックでその区間の頭へシーク。
- **一括エクスポート**: 全セッションを CSV 2 本でダウンロード（sessions.csv = セッション毎サマリ、events.csv = 全イベント + utc/ISO 列）。クライアント側で生成、サーバ変更なし。
- <1100px では縦積み（グラフ → リプレイ）。

## 5.3 GitHub Pages 版（2026-11-09 ユーザー指示: look & feel 優先、後で Supabase）

- 通信はすべて `public/shared/backend.js` 経由。`MODE`: Node サーバがあれば `"server"`（従来 /api）、github.io 等で /api が無ければ `"static"`。`"supabase"` は §5.4。
- static: 課題文 = `../data/experiments.json`、セッション一覧 = `../data/index.json` + このブラウザの IndexedDB に保存したセッション。実験の記録は IndexedDB に保存し、完了時に `<sessionId>.json`（{meta, events}）を自動ダウンロード。時刻同期は無し（unsynced 表示）。ダッシュボードは JSON ファイルのドラッグ&ドロップでも読める。
- デプロイ: GitHub Actions で `tools/build-pages.mjs` → `_site/`（public/* + data/ + experiments.json + index.json）→ Pages。ルートは実験とダッシュボードへのランディングページ。

## 5.4 Supabase モード（2026-11-09）

- `backend.js` の MODE `"supabase"`: `config.js` の `SUPABASE.url` が非空で、`/api` サーバが応答しない場合に選択（server が優先。`?backend=` で強制可）。素の fetch で PostgREST (`/rest/v1`) を呼ぶ。ヘッダは `apikey` のみ（sb_publishable_ は JWT でないため `Authorization: Bearer` は送らない）。課題文は static 同様 `../data/experiments.json`。
- テーブル（`supabase/schema.sql`）: `sessions`（§2 の meta を snake_case 列で。started_at / ended_at はサーバ UTC ms、client_ended_at はブラウザ値）、`events`（PK session_id+seq、`batch`=§1 の seq、`ev`=§4 のイベント JSON、`recv_at`=サーバ受信 UTC ms）、`syncs`（§3 の同期結果を `data` jsonb に、`recv_at` 付き）。
- `events` 挿入は `Prefer: resolution=ignore-duplicates` で冪等（再送 OK）。session_start を含むバッチで `started_at` を server_time() で設定。finish で `ended_at` = server_time()。
- `recv_at` の目的: ブラウザの時刻同期が失敗した場合に、バッチの受信時刻（recv_at）とバッチ最終イベントのローカル時刻 `lastT` の差からオフラインでオフセットを推定する（`getSession().meta.batchRecv = [{seq, recvAt, lastT, n}]`。下限推定で通信遅延分だけ過大）。
- 時刻同期（§3.B）: `rpc/server_time`（`clock_timestamp()` の UTC ms）を t1=t2 として使う。clock.js の `fetchTime` オプションで差し替え、同じ 20 サンプル最小遅延法。インターネット RTT 向けに good 判定は遅延 <300ms・spread <20ms（`goodDelay` / `goodSpread`）。
- `listSessions` は eventCount=null（セッション毎のカウントは遅いため）。`getSession` は keyset ページング（`seq > last`、1000 行/リクエスト上限対策）で全イベントを取得し、meta.eventCount を算出する。
- 注意: テスト段階の RLS は anon に select/insert（sessions は update も）を許可 = publishable key を持つ誰でも全データを読める。実験本番前に select を authenticated 研究者に限定する。
- 開発用: localhost のページに限り `?sburl=<url>` で接続先を上書きできる。

## 6. デザイン

共通トーン: 落ち着いた「文書ソフト」風。Word を模倣しない（ロゴ・リボン・色は使わない）が、
「白い紙が中央にあり、上に薄いツールバー、下にステータスバー」という文書エディタの文法に従う。

`public/shared/tokens.css` に :root 変数として定義（両画面で使用）:
- 色: `--bg: #EEF0F3`（机の色） `--paper: #FFFFFF` `--ink: #1F2328` `--ink-2: #59636E` `--line: #D8DEE4`
  `--accent: #2F5BD3`（操作・現在位置） `--warn: #C2410C`（減速区間） `--ok: #1A7F37`
- 文字: 本文 `"Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif` 16–18px / 行間 1.9
  UI `"Segoe UI", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif` 13px
  数値 `font-variant-numeric: tabular-nums`
- 角丸 6px、影は紙のみ `0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06)`
- 余白スケール 4/8/12/16/24/32/48
- ダークモード不要（実験環境の統一のため）。
