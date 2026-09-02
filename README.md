# geo-scan

中小企業のサイトが AI 検索（ChatGPT / Gemini / Perplexity / Claude）で「おすすめ」として出てくるかを計測し、スコアと改善提案を PDF レポートにする CLI ツールです。無料診断として営業に使うことを想定しています。

- Web UI はありません。`npm run ...` で動かします
- Google AI Overviews / AI モードは API がないため、目視結果を CSV で取り込みます
- 1 診断あたりの API 費用に上限（既定 500 円）を設け、超える見込みなら実行前に止まります

## セットアップ

Node 20 以上（22 でも可）。

```bash
git clone <this repo> && cd geo-scan
npm install            # puppeteer が Chrome を自動ダウンロードします（数分）
cp .env.example .env   # API キーを記入
```

依存は `@anthropic-ai/sdk`・`@google/genai`・`puppeteer` の 3 つだけです。OpenAI と Perplexity は fetch で直接呼びます（`openai@7` が Node 22 必須のため）。puppeteer は Node 20 で動く 24 系に固定しています（25 系は Node 22 必須）。`npm audit` が 24 系の Chrome ダウンロード処理（extract-zip）を指摘しますが、インストール時に Google の CDN から取得する zip の展開にしか使われません。Node 22 に上げるなら `puppeteer@^25` に変更できます。

`.env` に必要なキー:

| 変数 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | ChatGPT（Responses API + web_search） |
| `GEMINI_API_KEY` | Gemini（Google Search グラウンディング） |
| `PERPLEXITY_API_KEY` | Perplexity（sonar） |
| `ANTHROPIC_API_KEY` | Claude（web search）。質問生成・抽出・改善提案にも使います |

任意: `USD_JPY`（換算レート、既定 150）、`OPENAI_MODEL` などモデル上書き、`PUPPETEER_EXECUTABLE_PATH`（Chrome の場所）。各社 API の仕様と料金は [docs/api-notes.md](docs/api-notes.md) にまとめています。

## 対象の設定

`config/targets/<slug>.json` を作ります（`meguru` が入っています）。

```json
{
  "slug": "meguru",
  "name": "めぐる買取",
  "aliases": ["めぐる買取", "MEGURU", "株式会社RoyGBiv", "meguru-kaitori.jp"],
  "url": "https://meguru-kaitori.jp",
  "industry": "出張買取（貴金属・時計・ブランド品・着物）",
  "area": "大阪市東住吉区",
  "areaAliases": ["東住吉区", "大阪市", "大阪"],
  "competitors": ["おたからや", "買取大吉", "…"]
}
```

## コマンド

### 1. 質問を作る

```bash
npm run questions -- meguru          # Claude で 10 問生成（地域名入り 5・なし 5）
npm run questions -- meguru --force  # 既存ファイルを上書き
```

`config/questions/<slug>.json` に保存します。既にあれば上書きしません。`meguru` は初期 10 問を同梱済みなので、そのまま `scan` に進めます。質問は JSON を手で編集して構いません。

### 2. 計測する

```bash
npm run scan -- meguru --runs 3
```

10 問 × 4 エンジン × 3 回 = 120 回、各エンジンは Web 検索ありで質問します。並列は各エンジン 2 まで、失敗は 2 回リトライし、それでも失敗した回は `error` として記録して続行します。

- 実行前に概算費用を表示し、`--max-cost 500`（円）を超える見込みなら止まります。既定モデル（gpt-5.4-mini / gemini-3.5-flash / sonar / claude-sonnet-5）で 120 回まわすと概算は 800 円前後（1 ドル 150 円）なので、本番は `--max-cost 1000` のように指定するか、`.env` の `GEO_SCAN_MAX_COST` で既定値を変えてください。実費は `meta.json` に記録されます
- 生の回答・引用 URL・所要時間・費用は `runs/<slug>/<日付>/raw/*.json` に保存
- 続けて回答ごとに「言及の有無 / 何番目に出たか / 自社サイトの引用 / 競合名 / 引用ドメイン」を抽出し `extracted/*.json` に保存（正規表現 + Claude Haiku。`ANTHROPIC_API_KEY` がなければ正規表現のみ）
- 同じ日に再実行すると `runs/<slug>/<日付>/run-2/` のように分かれます

オプション: `--engines openai,gemini`（一部だけ）、`--date YYYY-MM-DD`（保存先の日付）、`--yes`（確認を省略）、`--skip-extract`、`--concurrency 2`。

抽出だけやり直す: `npm run extract -- meguru [--date YYYY-MM-DD] [--force]`

### 3. 手入力の結果を取り込む（Google AI Overviews など）

```bash
npm run import-manual -- meguru runs/manual.csv
```

CSV の列: `date, engine, question_no, mentioned(0/1), rank, cited_own(0/1), competitors(;区切り), notes`。サンプルは [samples/manual.csv](samples/manual.csv)。`engine` は `google_aio` / `google_aimode` のように付けると、レポートで「Google AI Overviews」「Google AIモード」と表示されます。同じ日付・エンジンを再取り込みすると置き換わります。

### 4. レポートを作る

```bash
npm run report -- meguru                        # 最新日
npm run report -- meguru --date 2026-09-02
npm run report -- meguru --compare 2026-09-01   # 指定日との Before/After
```

`runs/<slug>/<日付>/report.html` と `report.pdf` を出力します。内容: 表紙（総合スコア・一言サマリー）、エンジン別スコア、質問別 ○△×、代わりに出てきた業者 Top5 と理由、引用元ドメイン Top10、改善提案 3 点（Claude が結果を読んで生成）、計測方法、`--compare` 時は前回との差分と新しく出るようになった質問。

PDF 化に失敗する場合は `report.html` をブラウザで開いて「印刷 → PDF に保存」してください。Chrome の場所を `PUPPETEER_EXECUTABLE_PATH` で指定することもできます。

## スコア（0〜100）

| 項目 | 配点 | 計算 |
| --- | --- | --- |
| 言及率 | 50 | 社名（別名含む）が回答に出た割合 × 50 |
| 順位 | 30 | 言及があった回答で 1 位=30・2 位=20・3 位=12・4 位以下=5 の平均 |
| 自社サイト引用 | 20 | 引用 URL に自社ドメインが含まれた割合 × 20 |

エンジン別と総合の両方を出し、質問別に ○（全回で言及）△（一部の回）×（なし）を付けます。API エラーで回答が取れなかった回は集計から除外します。

## 開発・動作確認（API を呼ばない）

`--mock`（または `GEO_SCAN_MOCK=1`）で、`fixtures/mock-pool.json` から合成したダミー回答で一式を動かせます。

```bash
npm run scan -- meguru --runs 3 --mock --max-cost 600
npm run scan -- meguru --runs 3 --mock --max-cost 600 --date 2026-09-01 --seed before   # 前日分のダミー
npm run import-manual -- meguru samples/manual.csv
npm run report -- meguru --compare 2026-09-01
npm run scan -- meguru --mock --max-cost 1     # 費用上限で止まることの確認
npm run typecheck && npm test
```

`GEO_SCAN_MOCK_FAIL_RATE=0.3` を付けるとモックが確率的に失敗し、リトライと `error` 記録の経路を確認できます。

## ディレクトリ

```
config/targets/<slug>.json      対象企業
config/questions/<slug>.json    質問（生成 or 手書き）
runs/<slug>/<日付>/             raw/ extracted/ manual/ meta.json aggregate.json report.html report.pdf
runs/<slug>/<日付>/run-2/       同日の 2 回目以降
src/commands/                   questions / scan / extract / importManual / report
src/providers/                  openai / gemini / perplexity / anthropic / mock
src/lib/                        抽出・スコア・集計・HTML・PDF・費用など
docs/api-notes.md               各社 API の仕様と料金メモ
```

## 注意

- API キーはログ・raw JSON・レポートに出しません（キーらしき文字列は保存前に伏せます）
- 各社 API の規約の範囲内で使ってください。AI の回答本文は再配布せず、レポートには要約と短い抜粋のみを載せています
- AI の回答は同じ質問でも変動します。3 回平均でも日や時間帯で結果が動くので、レポートには計測日時とモデル名を明記しています
