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

任意: `USD_JPY`（換算レート、既定 150）、`GEO_SCAN_MAX_COST`（`--max-cost` の既定値）、`OPENAI_MODEL` などモデル上書き、`PUPPETEER_EXECUTABLE_PATH`（Chrome の場所）、`GEO_SCAN_TZ`（レポートの時刻表示、既定 Asia/Tokyo）、`GITHUB_TOKEN`（`npm run update` で、リポジトリを非公開にしている場合のみ）。各社 API の仕様と料金は [docs/api-notes.md](docs/api-notes.md) にまとめています。

## 新しい版に入れ替える（更新）

### コマンドで更新する（おすすめ）

```bash
npm run update            # GitHub の main を取得して入れ替える（確認あり）
npm run update -- --check # 何が変わるかだけ見る（入れ替えない）
npm run update -- --yes   # 確認なしで入れ替える
```

git は使いません。GitHub から zip をダウンロードして展開し、差分だけ入れ替えます。**残すもの**は次の 4 つです。

| 残るもの | 中身 |
| --- | --- |
| `.env` | API キーと設定 |
| `runs/` | これまでの計測結果・レポート |
| `config/targets/` | 診断対象（既存ファイルは上書きしません） |
| `config/questions/` | 質問（同上） |

そのほか、フォルダ直下に自分で置いたファイル（CSV やメモ）も消しません。逆に、新しい版で無くなったソースファイルは削除します（古いファイルが残って動かなくなるのを防ぐため）。入れ替え前のファイルは一時フォルダに退避し、途中で失敗したら元に戻します。`package.json` の依存が変わったときは自動で `npm install` を実行します（`--no-install` で止められます）。

設定は要りません。`npm run update` だけで動きます。

オプション: `--branch <名前>`（既定 main）、`--repo owner/name`、`--zip <ファイル>`（ダウンロード済みの zip を使う）、`--no-install`。更新後は `.geo-scan-version.json` に取得したコミットが記録されます。

うまくいかないときは、下の「Zip で入れ替える」に切り替えてください。会社のネットワークでプロキシを通す場合は `NODE_USE_ENV_PROXY=1 npm run update` を試してください。

> **補足: リポジトリを非公開（private）にしている場合**
> 認証なしでは zip を取得できず「見つかりません」というエラーになります。[Personal Access Token](https://github.com/settings/tokens) を「Contents: read」の権限で作り、`.env` に `GITHUB_TOKEN=ghp_xxxx` と書いてください。公開リポジトリなら不要です（書いてあっても動きます）。

### Zip で入れ替える（git も update コマンドも使わない）

1. <https://github.com/meguru88/geo-scan> を開き、緑の **Code** → **Download ZIP**（非公開にしている場合は GitHub にログインした状態で）
2. ダウンロードした zip を展開する（`geo-scan-main` というフォルダができます）
3. **今のフォルダから、次の 4 つを新しいフォルダにコピーする**
   - `.env`（API キー。これが無いと動きません）
   - `runs/`（これまでの計測結果とレポート）
   - `config/targets/`（診断対象）
   - `config/questions/`（質問）
4. 今のフォルダを `geo-scan-old` などに名前を変え、新しいフォルダの名前を `geo-scan` にする
5. ターミナルで新しいフォルダに移動して `npm install`
6. 動作を確認できたら `geo-scan-old` を削除する

古いフォルダに新しいファイルを上書きコピーするのではなく、**フォルダごと入れ替えて、残したいものだけを持っていく**のが安全です（上書きだと、新しい版で無くなったファイルが残って動かなくなることがあります）。

macOS / Linux ならコマンドでもできます（`~/geo-scan` に置いている場合）。

```bash
cd ~/Downloads && unzip geo-scan-main.zip
cp ~/geo-scan/.env geo-scan-main/
cp -R ~/geo-scan/runs geo-scan-main/
cp -R ~/geo-scan/config/targets ~/geo-scan/config/questions geo-scan-main/config/
mv ~/geo-scan ~/geo-scan-old && mv geo-scan-main ~/geo-scan
cd ~/geo-scan && npm install
```

## 対象の設定

### 1コマンドで追加する（おすすめ）

```bash
npm run add -- --slug royg --url https://roygbiv.stars.ne.jp/ --name "ヘルパーステーションRoyG"
```

サイトを読んで設定と質問を作り、そのまま計測まで進めます。

1. URL を取得して title・meta description・本文を抽出（Shift_JIS などの日本語サイトにも対応）
2. Claude（`claude-opus-5`）が社名の表記ゆれ・業種・地域を推定
3. その業種と地域の主要な競合 10 社を Web 検索で調査
4. `config/targets/<slug>.json` と `config/questions/<slug>.json` を書き出し
5. 内容と概算費用を表示して「このまま計測しますか？」と確認 → `y` で `scan` → `report` まで実行

`--name` を省くとサイトから推定します。`--industry` `--area` でも上書きできます。`--yes` を付けると確認なしで最後まで走ります。既存の slug があるときは上書きせず止まります（`--force` で上書き）。`ANTHROPIC_API_KEY` が必要です。

概算費用が `--max-cost`（既定 500 円）を超える場合は設定ファイルだけ作り、実行するコマンドを案内して止まります。最初から通したいときは `--max-cost 1000` のように指定してください。

### 手で書く

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

検索エンジンに渡す「利用者の位置」は既定で国（JP）だけです。市区町村まで渡したい場合は `"searchLocation": { "city": "Osaka", "region": "Osaka", "latitude": 34.6937, "longitude": 135.5023 }` を追加してください（地域名なしの質問まで地域に寄るので、計測の意図に合わせて選びます。レポートの計測方法欄に記載されます）。

## コマンド

### 0. 対象を追加する

```bash
npm run add -- --slug royg --url https://roygbiv.stars.ne.jp/ --name "ヘルパーステーションRoyG"
npm run add -- --slug royg --url https://roygbiv.stars.ne.jp/ --yes --max-cost 1000   # 確認なしで計測まで
```

オプション: `--name` `--industry` `--area`（推定の上書き）、`--force`（既存を上書き）、`--yes`（確認を省略）、`--runs` `--max-cost` `--engines`（続けて走る scan に渡す）。詳細は「対象の設定」を参照。

`--engines openai,gemini` のように絞ると、概算費用の表示も続けて実行する scan もそのエンジンだけになります。

### 1. 質問を作る

```bash
npm run questions -- meguru          # Claude で 10 問生成（地域名入り 5・なし 5）
npm run questions -- meguru --force  # 既存ファイルを上書き
```

`config/questions/<slug>.json` に保存します。既にあれば上書きしません。`meguru` は指定された初期 10 問を同梱済み（すべて地域名入り）なので、そのまま `scan` に進めます。`--force` で再生成すると 5/5 の構成になります。質問は JSON を手で編集して構いません。

### 2. 計測する

```bash
npm run scan -- meguru --runs 3 --max-cost 1000
```

10 問 × 4 エンジン × 3 回 = 120 回、各エンジンは Web 検索ありで質問します。並列は各エンジン 2 まで、失敗は 2 回リトライし、それでも失敗した回は `error` として記録して続行します。

- 実行前に概算費用を表示し、`--max-cost 500`（円）を超える見込みなら止まります。既定モデル（gpt-5.4-mini / gemini-3.5-flash / sonar / claude-sonnet-5）で 120 回まわすと概算は 700〜800 円（1 ドル 150 円）なので、本番は `--max-cost 1000` のように指定するか、`.env` の `GEO_SCAN_MAX_COST` で既定値を変えてください
- 実行中も実費を積算し、上限に達したら残りの呼び出しは行わず `skipped` として記録します（レポートでは集計対象外として件数を表示）
- 生の回答・引用 URL・所要時間・費用は `runs/<slug>/<日付>/raw/*.json` に、合計と使った質問・モデルは `meta.json` に保存
- 続けて回答ごとに「言及の有無 / 何番目に出たか / 自社サイトの引用 / 競合名 / 引用ドメイン」を抽出し `extracted/*.json` に保存（正規表現 + Claude Haiku。`ANTHROPIC_API_KEY` がなければ正規表現のみ）
- 同じ日に再実行すると `runs/<slug>/<日付>/run-2/` のように分かれ、`report` と `extract` は既定で最新の run を使います（`--run N` で指定可。1 が最初の run）
- 対話できない環境（cron など）では `--yes` が必要です

オプション: `--engines openai,gemini`（一部だけ）、`--date YYYY-MM-DD`（保存先の日付）、`--yes`（確認を省略）、`--skip-extract`、`--concurrency 1`（既定 2、上限 2）。

抽出だけやり直す: `npm run extract -- meguru [--date YYYY-MM-DD] [--run N] [--force]`

### 3. 手入力の結果を取り込む（Google AI Overviews など）

```bash
npm run import-manual -- meguru runs/manual.csv
```

CSV の列: `date, engine, question_no, mentioned(0/1), rank, cited_own(0/1), competitors(;区切り), notes`。サンプルは [samples/manual.csv](samples/manual.csv)。`engine` は `google_aio` / `google_aimode` のように付けると、レポートで「Google AI Overviews」「Google AIモード」と表示されます。同じ日付・エンジンを再取り込みすると置き換わります。入力していない質問は「未入力」として集計に含めません。

### 4. レポートを作る

```bash
npm run report -- meguru                        # 最新日
npm run report -- meguru --date 2026-09-02 --run 1
npm run report -- meguru --compare 2026-09-01   # 指定日との Before/After
npm run report -- meguru --no-pdf               # HTML だけ
```

`runs/<slug>/<日付>/report.html` と `report.pdf`（run-2 以降はその run のディレクトリ）を出力します。内容: 表紙（総合スコア・一言サマリー）、エンジン別スコア、質問別 ○△×、代わりに出てきた業者 Top5 と理由、引用元ドメイン Top10、改善提案 3 点（Claude が結果を読んで生成）、計測方法、`--compare` 時は前回との差分と新しく出るようになった質問。比較は両日で計測したエンジンだけで総合を再計算し、途中で質問文を変えた質問は比較から外します。

PDF 化に失敗する場合は `report.html` をブラウザで開いて「印刷 → PDF に保存」してください。Chrome の場所を `PUPPETEER_EXECUTABLE_PATH` で指定することもできます。

### 5. ツール自体を更新する

```bash
npm run update
```

`.env` と `runs/`、`config/targets/`、`config/questions/` を残したまま最新版に入れ替えます。詳細は上の[「新しい版に入れ替える（更新）」](#新しい版に入れ替える更新)を参照してください。

## スコア（0〜100）

| 項目 | 配点 | 計算 |
| --- | --- | --- |
| 言及率 | 50 | 社名（別名含む）が回答に出た割合 × 50 |
| 順位 | 30 | 言及があった回答で 1 位=30・2 位=20・3 位=12・4 位以下=5 の平均 |
| 自社サイト引用 | 20 | 引用 URL に自社ドメインが含まれた割合 × 20 |

エンジン別と総合の両方を出し、質問別に ○（有効な回答すべてで言及）△（一部の回）×（なし）を付けます。API エラーで回答が取れなかった回は分母から除外します（3 回中 1 回失敗して残り 2 回とも言及なら ○ 2/2 と表示）。

## 開発・動作確認（API を呼ばない）

`--mock`（または `GEO_SCAN_MOCK=1`）で、`fixtures/mock-pool.json` から合成したダミー回答で一式を動かせます。概算費用は本番の料金で計算されるので `--max-cost` は上げておきます。

```bash
npm run scan -- meguru --runs 3 --mock --max-cost 1000
npm run scan -- meguru --runs 3 --mock --max-cost 1000 --date 2026-09-01 --seed before   # 前日分のダミー
npm run import-manual -- meguru samples/manual.csv
npm run report -- meguru --compare 2026-09-01
npm run scan -- meguru --mock --max-cost 1     # 費用上限で止まることの確認（終了コード 1）
npm run typecheck && npm test
```

`GEO_SCAN_MOCK_FAIL_RATE=0.3` を付けるとモックが確率的に失敗し、リトライと `error` 記録の経路を確認できます。

## ディレクトリ

```
config/targets/<slug>.json      対象企業
config/questions/<slug>.json    質問（生成 or 手書き）
runs/<slug>/<日付>/             raw/ extracted/ manual/ meta.json aggregate.json report.html report.pdf
runs/<slug>/<日付>/run-2/       同日の 2 回目以降
src/commands/                   add / questions / scan / extract / importManual / report / update
src/providers/                  openai / gemini / perplexity / anthropic / mock / location
src/lib/                        サイト取得・素性推定・抽出・スコア・集計・比較・HTML・PDF・費用・更新など
.geo-scan-version.json          npm run update で取得したコミット（自動生成）
docs/api-notes.md               各社 API の仕様と料金メモ
```

## 注意

- API キーはログ・raw JSON・レポートに出しません（保存前にキーらしき文字列と .env の値を伏せ、PDF 化の Chrome にも渡しません）
- 各社 API の規約の範囲内で使ってください。AI の回答本文は再配布せず、レポートには要約と短い抜粋のみを載せています
- AI の回答は同じ質問でも変動します。3 回平均でも日や時間帯で結果が動くので、レポートには計測日時とモデル名を明記しています
