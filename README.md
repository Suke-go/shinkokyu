# 転記タイピング実験

依存ゼロ（Node 24 だけ）。仕様は [SPEC.md](SPEC.md)、根拠は [docs/survey/](docs/survey/)。

```
node server/server.js          # http://127.0.0.1:8787  (LAN の別PCから使うなら HOST=0.0.0.0)
```

- 被験者: http://127.0.0.1:8787/experiment/ → 実験ID（`demo-ja` / `demo-en`）と参加者IDで準備 → スタート（全画面＋時刻同期）→ 完了
- 研究者: http://127.0.0.1:8787/dashboard/ → 速度(CPM)と停止率の2レーンのタイムライン。減速区間は帯で表示、ホバーでその時点の入力文、帯クリックでズーム
- 課題文: `server/experiments.json` を編集（再起動不要）
- ログ: `data/<sessionId>.json`（メタ・同期結果）と `data/<sessionId>.events.jsonl`（全キーイベント、ローカル時刻のまま。UTC 補正は解析時）
- デモデータ: `node tools/make-demo.js`

テスト: `node server/test.js` / `node public/shared/clock.test.js` / `node public/shared/metrics.test.js` / E2E `node tools/e2e.mjs <作業用フォルダ>`（Edge 必須）

## GitHub Pages（静的デモ版）

`.github/workflows/pages.yml` が main への push で `node tools/build-pages.mjs _site` を実行して Pages に公開（リポジトリ設定の Pages > Source を "GitHub Actions" に）。例: https://suke-go.github.io/shinkokyu/
- サーバ無し: 課題文は `data/experiments.json`、記録はこのブラウザの IndexedDB に保存し、完了時に `<sessionId>.json` を自動ダウンロード。時刻同期は無し。
- ダッシュボードはこのブラウザの記録と、ビルド時に同梱した `data/` のセッションを一覧する。URL に `?backend=static|server` で強制切替。
- ローカル確認: `node tools/build-pages.mjs _site` → `_site` を任意の静的サーバで配信。

## Supabase（本番寄りの保存先）

1. Supabase の SQL Editor に [supabase/schema.sql](supabase/schema.sql) を貼って実行（何度実行しても安全）。
2. Project URL（`https://xxxx.supabase.co`）を `public/shared/config.js` の `SUPABASE.url` に書く（publishable key は公開前提で入っている）。
3. commit & push（Pages が再ビルド）。Node サーバが無い環境では自動で supabase モードになる。`?backend=static|server|supabase` で強制切替。
- 注意: テスト段階の RLS は「publishable key を持つ誰でも全データ閲覧可」。実験本番の前に select を研究者(authenticated)に限定すること。
