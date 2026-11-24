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
| GET | `/api/experiments/:expId` | – | `{ "expId", "title", "lang", "text", "limitMin"? }` 404 if unknown。`limitMin` があれば、課題は `session_start` からその分数で自動的に終了する（終了確認なしで送信に進む） |
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
- `type`: `keydown` `keyup` `input` `compositionstart` `compositionupdate` `compositionend` `paste` `focus` `blur` `snapshot` `session_start` `session_end` `vital` `breath` `baseline_start` `baseline_end`
- `vital` / `breath`: デスクトップアプリ（§5.5）内でのみ発生。`vital` はレーダーの 2 秒毎の推定で、`data` は JSON 文字列 `{"quality","present","snr","range","br","period","depth","regular","moving","hr","q"}`（`quality` 0〜3: 0 何も映っていない / 1 何かが映っている / 2 呼吸している人 / 3 呼吸が安定して区切れている。解析には 3 を使う）。`breath` は 1 呼吸が終わるたびに 1 件で、`t` はその呼吸の終わった時刻、`data` は `{"period","depth"}`（秒, mm）。安静時の呼吸は課題の前に、アプリの最初の画面のストップウォッチで測る（開始と終了は実験者が押す。`localStorage.baselineMinutes` は長さの目安、既定 3 分）。結果は `rest_<UTC 日時>.json`（`{"t0","t1","seconds","planned","breaths","period_s"}`、`t0`/`t1` は PC の時計の ms）に残り、`radar/export.py` が、課題の開始前 1 時間以内で最後に終わった安静をその課題と組にする。0.3.0 までは課題の画面の中で測っていて、その記録には `baseline_start` / `baseline_end` が `session_start` より前に入っている。その `baseline_end` の `data` は `{"seconds","skipped","steady_share","breaths","period","period_iqr","depth","hr"}`。どちらも `t` はこのページのローカル時刻。metrics.js は無視する。
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
- 時刻同期（§3.B）: `rpc/server_time`（`clock_timestamp()` の UTC ms）を t1=t2 として使う。clock.js の `fetchTime` オプションで差し替え、同じ 20 サンプル最小遅延法。やり直しは 1 回まで（インターネット越しでは 2 周目で良くなることが少ない）。応答が 3 秒返らない要求は、どのモードでもそのサンプルを捨てて先へ進む。インターネット RTT 向けに good 判定は遅延 <300ms・spread <20ms（`goodDelay` / `goodSpread`）。
- `listSessions` は eventCount=null（セッション毎のカウントは遅いため）。`getSession` は keyset ページング（`seq > last`、1000 行/リクエスト上限対策）で全イベントを取得し、meta.eventCount を算出する。
- 注意: テスト段階の RLS は anon に select/insert（sessions は update も）を許可 = publishable key を持つ誰でも全データを読める。実験本番前に select を authenticated 研究者に限定する。
- 開発用: localhost のページに限り `?sburl=<url>` で接続先を上書きできる。

## 5.5 レーダー計測 `radar/`（2026-11-15）

デスクトップアプリ（`radar/app`、Tauri: Rust + TS）と `radar/vitals.py` の 2 実装。チャープ設定は `radar/chirp.cfg` を共有し、推定方法・ファイル形式は同一。使い方は `radar/README.md`。

- アプリ: Pages 版のサイト（§5.3）を同梱し、タイピング課題を別ウィンドウで開く。課題の `session_start` で `start {session, pageNow}` を呼び、アプリは自分の時計とページの時計（`pageNow`）の差を取って（`radar_*.json` の `clockOffsetMs`）、以後の時刻をページのローカル時刻で付ける。推定は `vital` / `breath` イベント（§4）としてページのイベント列に入るので、**時刻同期と保存はタイピングのセッションの 1 系統だけ**。アプリ内ではセッションをこの PC にも保存する: 「ドキュメント/shinkokyu-radar」に `typing_<sessionId>.json`（§2 と同形、書き換え）と `typing_<sessionId>.events.jsonl`（追記）、レーダーの生データ `radar_<sessionId>.*`。Supabase に届かないときは static モードに落として、送信なしで進む。最初の画面（向き合わせ）の線は、胸のビンの位相の変化をフレーム毎に積んだもの（`wave` イベント、毎秒 20 回。画面側でガウシアン平滑化と基線除去をかける。表示専用で記録しない）。数字と判定は 1 秒毎に更新し、信号の質（`quality`）を 3 本のバーと理由の 1 行（`quality_why`）で出す。レーダーの記録は課題のスタートから終了まで途切れない。そこで測ったときは `radar_<UTC stamp>.*` に、この PC の時計（同期なし）で保存する。
- `vitals.py`: 単独記録。下記の「時刻」のとおり自分で同期する。

- 機材: PTM RFR79ITR34-30U（TI IWR1843、mmWave SDK 3.5 標準デモ FW、FT4232H: チャネル A = CLI 115200bps / B = データ 921600bps）。77.0–80.82GHz、1TX/4RX、64 距離ビン（約 4.8cm）、40 フレーム/秒（位相が折り返さない上限 38mm/s）。1 フレーム = 0.75ms 間隔の 16 チャープ（12ms）で、その和（ゼロドップラー）を使うため約 8cm/s より速い動き（打鍵中の手・腕）は打ち消される。
- 取得: 標準デモの range-azimuth heatmap TLV（ゼロドップラーの距離ビン複素値）。手順は `radar/README.md`「測定の仕組み」と `radar/breathing.py` の冒頭: 動かない反射の除去（円フィット）→ 距離ビン毎の位相差 = 速度 → 飛びの切り落とし → ガウシアン平滑化と基線除去 = 呼吸の波形 → いちばん規則的な距離ビンを胸とする → 波形の上がりと下がりの 1 組（直近の振れの 3 割以上）で 1 呼吸に区切る → 残りから心拍数（呼吸の倍音は心拍にしない）。呼吸は直近 30 秒、心拍は直近 20 秒を見て、記録は 2 秒毎。人が映っているか（`present`）は、測定ビンの反射が雑音床（0.3m 以遠のビンの振幅の 20 パーセンタイル）より 16dB 以上強く（胸 28〜39dB、背中 19〜29dB、何も無いと 7〜13dB）、かつ呼吸波形の振れが 0.3mm 以上であること。アプリは 0.5 秒毎に距離ビン毎の反射（雑音床比 dB）を `seen` イベントで画面に出す。記録の様子は `radar/report.py` で図と要約にできる。
- 時刻（`vitals.py`）: §3.B と同じ方式で開始時・終了時に同期し、`.json` の `syncs` に §3 と同形（+ `source`）で保存（`makeOffsetFn` がそのまま使える）。同期先は backend.js と同じ選び方: `/api/time` が応答すれば server、無ければ Supabase `rpc/server_time`。突き合わせるタイピング画面と同じ同期先にする（`--backend`）。**記録時刻は生のローカル ms**、補正は解析時（§3 と同じ方針）。タイピングのセッションとは UTC の重なりで突き合わせる。
- ファイル `radar_<sessionId または UTC stamp>.*`（アプリ: ドキュメント/shinkokyu-radar、`vitals.py`: `radar/captures`）: `.json`（設定。アプリは sessionId、`vitals.py` は syncs）/ `.bin`（全フレーム。固定長レコード `t` float64 到着ローカル ms, `fnum` uint32, `iq` int16[64][4][imag,real]）/ `.hr.jsonl`（`{t, window, quality, present, snr_db, range_m, span_mm, br_period_s, br_bpm, br_q, br_depth_mm, br_span_mm, br_range_m, br_moving, hr_bpm, hr_q, hr_peak_bpm, breaths}`。`t` は推定の時刻）/ `.png`（`vitals.py` のみ。最後の窓の波形）。
- フレーム時刻 = レーダーのフレーム番号 × 25ms + 最小遅延の到着時刻で決めた基準。残差は約 15–20ms の遅れ（フレーム処理 + UART）と水晶ドリフト。

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
