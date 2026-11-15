# レーダー計測（非接触の心拍・呼吸）

79GHz 帯レーダー評価キット PTM RFR79ITR34-30U（TI IWR1843 搭載）で、座っている人の心拍数と呼吸数を測り、タイピング実験と同じ時計で記録する。

実装は 2 つある。チャープ設定（[chirp.cfg](chirp.cfg)）、推定方法、出力ファイルは共通。

- デスクトップアプリ [app/](app/)（Tauri。Rust + TypeScript、Windows / macOS）
- Python スクリプト [vitals.py](vitals.py)

## 用意するもの

- レーダー本体と USB Type-C ケーブル。給電も USB。同梱の DA ボードは使わない。
- ファームウェアは出荷時のまま（mmWave SDK 3.5 のデモ）。
- PC にはシリアルポートが 2 つ現れる（FTDI FT4232H）。現れない場合は FTDI の VCP ドライバを入れる。ポート番号の指定は要らない。

## 置き方

- レーダーは三脚とクランプで固定し、ケーブルも動かないように留める。ケーブルが揺れると USB 接続が切れる。切れても自動で繋ぎ直し、記録は続く。
- 胸の正面、0.5〜0.8 m。測れるのは 0.3〜1.5 m。
- 上下方向のビームは ±10° ほどしかない。0.6 m 先で上下 ±10 cm なので、高さを胸骨に合わせる。左右は ±50° ほどと広い。

## アプリ

[Releases](https://github.com/Suke-go/shinkokyu/releases) からインストーラーを取る（Windows は `.exe`、macOS は `.dmg`）。署名はしていないので、初回は Windows なら「詳細情報 → 実行」、macOS なら右クリック →「開く」。

丸いボタンで開始と停止。開始後、輪が一周するまでの 20 秒は最初の推定に必要なデータを溜めている。

- 大きい数字: 心拍数（毎分）
- その下: 呼吸数（毎分）
- 線: 胸の変位（直近 20 秒）

数字が薄いときは、その推定を使わない（体が動いている、前に人がいない）。

記録は「ドキュメント/shinkokyu-radar」に保存される。

## Python スクリプト

```
pip install pyserial numpy matplotlib
python radar/vitals.py                # Ctrl+C で終了
python radar/vitals.py --seconds 300  # 5 分で終了
```

記録は `radar/captures` に保存される。終了時に最後の 20 秒の波形を `.png` でも出す。

## 時刻同期

開始時と終了時に、タイピング画面と同じ方式（[SPEC.md](../SPEC.md) §3.B）で時計のずれを測り、記録に残す。測定値の時刻はこの PC のローカル時刻のまま保存し、補正は解析時に行う。

同期先はタイピング画面と同じ規則で決まる。ローカルの実験サーバー（`node server/server.js`）が動いていればそれ、なければ Supabase。レーダーとタイピングで同期先が違うと、その差がそのまま両者のずれになる。ローカルサーバーを動かしたまま GitHub Pages 版でタイピングさせる場合は、Python スクリプトに `--backend supabase` を付ける（アプリは自動選択のみ）。

## 出力ファイル

1 回の計測で `radar_<UTC 日時>.*` ができる。

| ファイル | 中身 |
|---|---|
| `.json` | チャープ設定、フレームレート、時刻同期の結果（`syncs`。`public/shared/clock.js` の `makeOffsetFn` にそのまま渡せる） |
| `.bin` | 全フレームの生データ。固定長レコード: 到着時刻 `float64`（ローカル ms）、フレーム番号 `uint32`、IQ `int16[64][4][虚部, 実部]`（距離ビン × アンテナ）。リトルエンディアン、約 150 MB/時 |
| `.hr.jsonl` | 2 秒ごとの推定。`t`（ローカル ms）までの 20 秒間についての値 |

`.hr.jsonl` の 1 行:

| キー | 意味 |
|---|---|
| `hr_bpm` / `br_bpm` | 心拍数 / 呼吸数（毎分） |
| `hr_q` | 心拍帯域の電力のうち、ピーク ±0.1 Hz に入る割合。0.35 未満の行は使わない |
| `span_mm` | 呼吸帯域での胸の変位の振れ幅。0.2 未満なら前に人がいない |
| `hr_harmonic` | 心拍のピークが呼吸の倍音（2〜6 倍）と重なっている |
| `range_m` | 測っている距離 |

Python での読み方:

```python
import json, numpy as np
import vitals  # radar/vitals.py

rec = np.fromfile("radar_20261115-101247.bin", dtype=vitals.REC)
rows = [json.loads(l) for l in open("radar_20261115-101247.hr.jsonl")]
```

## 測定の仕組み

1 フレームは 0.75 ms 間隔の 16 チャープで、毎秒 40 フレーム。ファームウェアが出すのは 16 チャープの和（速度ゼロの成分）なので、約 8 cm/s より速く動くもの（キーを打つ手や腕）は打ち消され、胸（2 cm/s 未満）が残る。

体が写っている距離ビンと 4 本の受信アンテナをまとめて、フレーム間の位相差を求める。位相差は胸の速度、その累積は変位（1 周で波長の半分、約 1.9 mm）。呼吸数は変位の 0.1〜0.6 Hz、心拍数は速度の 0.8〜2.5 Hz のスペクトルのピークから求める。

送信は 77.0〜80.82 GHz（ARIB STD-T111 の 77〜81 GHz の内側）、送信アンテナは 1 本。

## 確認できていること

- 静止して座った状態で、心拍数が 68〜73 bpm の範囲に 20 秒ほど安定して出る。
- パルスオキシメーターなどの基準との照合はしていない。
- 姿勢を変えたり前に乗り出したりしている間は推定が外れる。その区間は `hr_q` が下がる。
- 呼吸数は心拍数より安定しない。
- アプリと Python スクリプトは、同じ `.bin` から同じ推定値を出す。
- macOS では動かしていない。

## 開発

```
python radar/test_vitals.py                 # Python の自己チェック（レーダー不要）

cd radar/app
npm ci
npx tauri dev                               # アプリを起動
cd src-tauri
cargo test
cargo run --release --example headless -- replay <file.bin>          # 保存した .bin から推定
cargo run --release --example headless -- record 60 <出力先の接頭辞>   # 画面なしで 60 秒記録
```

`radar-v0.1.0` のようなタグを push すると、GitHub Actions が Windows と macOS のインストーラーを作り、Release の下書きに付ける。
