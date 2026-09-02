# 各社 Web 検索 API の仕様メモ（2026-09-02 調査）

geo-scan の 4 エンジンをどう呼ぶか、引用がどう返るか、いくらかかるかの一覧。
公式ドキュメント・公式 SDK のソース（OpenAPI / discovery / 型定義）を読んで確認したもの。
「※snippet」は公式ページ自体が取得できず検索結果の抜粋で確認した値なので、初回実行時に raw JSON と請求で再確認すること。

## 1 画面まとめ

| | ChatGPT (OpenAI) | Gemini (Google) | Perplexity | Claude (Anthropic) |
| --- | --- | --- | --- | --- |
| エンドポイント | `POST /v1/responses` | `POST /v1beta/models/{model}:generateContent` | `POST /chat/completions` | `POST /v1/messages` |
| 呼び方 | fetch（openai@7 は Node 22 必須のため SDK 不使用） | `@google/genai` 2.x（3.0 は Node 22 必須） | fetch（公式 SDK は ESM-only、fetch と同じ body） | `@anthropic-ai/sdk` 0.123 |
| 既定モデル | `gpt-5.4-mini`（無料ユーザー向けの mini 世代） | `gemini-3.5-flash`（Gemini アプリの既定） | `sonar` | `claude-sonnet-5`（claude.ai Free/Pro の既定） |
| 検索の有効化 | `tools:[{type:"web_search"}]` | `config.tools:[{googleSearch:{}}]` | 常時（sonar 系は検索込み） | `tools:[{type:"web_search_20260209",name:"web_search"}]` |
| 日本ロケール | `tools[].user_location:{type:"approximate",country:"JP",timezone:"Asia/Tokyo"}`（city/region は任意） | `config.toolConfig.retrievalConfig:{languageCode:"ja-JP"}`（`latLng` は任意） | `web_search_options.user_location:{country:"JP"}`（region/city は任意） | `tools[].user_location:{type:"approximate",country:"JP",timezone:"Asia/Tokyo"}`（city/region は任意） |
| システム指示 | `instructions` | `config.systemInstruction` | `messages[0]{role:"system"}` | `system` |
| 回答本文 | `output[].type=="message"` → `content[].type=="output_text"` → `.text` | `candidates[0].content.parts[].text`（`thought:true` は除く） | `choices[0].message.content` | `content[].type=="text"` → `.text`（複数ブロックを連結） |
| 引用 URL | 同 `content[].annotations[]` の `type:"url_citation"` `{url,title,start_index,end_index}` | `candidates[0].groundingMetadata.groundingChunks[].web` `{uri,title}` ※uri はリダイレクト URL、title がホスト名 | `search_results[]` `{title,url,date,snippet}`（旧 `citations[]` は URL 文字列） | `content[].citations[]` の `type:"web_search_result_location"` `{url,title,cited_text}` |
| 検索回数 | `output[]` の `type:"web_search_call"` の数 | `groundingMetadata.webSearchQueries.length` | 1 リクエスト = 1 回 | `usage.server_tool_use.web_search_requests` |
| トークン | `usage.input_tokens / output_tokens`（検索コンテンツは input に含む、reasoning は output に含む） | `usageMetadata.promptTokenCount / candidatesTokenCount / thoughtsTokenCount` | `usage.prompt_tokens / completion_tokens` と `usage.cost.total_cost`（サーバー計算の USD） | `usage.input_tokens / output_tokens`（thinking は output に含む） |
| トークン単価 (USD/1M) | in 0.75 / out 4.50 ※snippet | in 1.50 / out 9.00（思考トークンも out） | in 1 / out 1 ※snippet | in 2 / out 10 |
| 検索料金 | $10 / 1,000 calls ＋ 検索コンテンツのトークン ※snippet | $14 / 1,000 クエリ（Gemini 3 系は月 5,000 クエリまで無料） | リクエスト料 $8 / 1,000（`search_context_size: medium`、low は $5）※snippet | $10 / 1,000 searches |
| 1 回あたり概算 | 約 $0.03 | 約 $0.05（無料枠内なら約 $0.02） | 約 $0.01 | 約 $0.07 |

概算の前提: 600 字程度の日本語回答。実費は各回答の raw JSON に記録し、`meta.json` に合計を書く。
10 問 × 4 エンジン × 3 回 = 120 回で **約 $5（1 ドル 150 円で約 800 円）**、抽出（Haiku）が約 $0.4。`--max-cost` の既定 500 円だと止まるので、本番は `--max-cost 1000` などを指定する。

## OpenAI（Responses API + web_search）

- `openai@7.9.0` は `engines.node >=22`（Node 20 は 2026-04-30 EOL で非対応）。geo-scan は Node 20 前提なので fetch で `POST https://api.openai.com/v1/responses` を直接呼ぶ。
- リクエスト: `{ model, instructions, input, tools:[{ type:"web_search", search_context_size:"medium", user_location:{...} }], include:["web_search_call.action.sources"], reasoning:{ effort:"low" } }`
  - `gpt-5.4-mini` の reasoning 既定は `none` で、ガイドは「web search では効果なしだと品質が落ちる」と注意しているため `low` を明示（`OPENAI_REASONING_EFFORT` で変更可）。`minimal` は web search 非対応。
  - `web_search_preview` は旧ツール（非推論モデルでは $25/1k）。新規は `web_search`。
- レスポンス: `output[]` は `reasoning` → `web_search_call`（複数あり得る。`action.type` は search / open_page / find_in_page）→ `message` の順。`output[0]` を本文と決め打ちしない。
  - 引用 URL には `?utm_source=chatgpt.com` が付くので、ドメイン比較・重複除去の前にクエリを落とす。
  - `status` が `incomplete`（`max_output_tokens` 到達）なら `incomplete_details` を確認。
- 料金 ※snippet: `gpt-5.4-mini` in $0.75 / out $4.50、web search $10/1k calls（`web_search_call` 1 件ごと）＋検索コンテンツトークンは入力単価。代替: `gpt-5-mini`（$0.25/$2.00）、`gpt-5.5`（$5/$30、ChatGPT の既定 "GPT-5.5 Instant" に最も近い）。
- 確認元: openai/openai-openapi `openapi.yaml`、openai-node `src/resources/responses/responses.ts`、README（Node バージョン方針）。料金ページ・モデルページは取得不可（snippet のみ）。

## Google Gemini（Google Search グラウンディング）

- `@google/genai` 2.20.0（`engines.node >=20`、3.0 で Node 22 必須になるため `<3.0.0` に固定）。`ai.models.generateContent({ model, contents, config:{ systemInstruction, tools:[{googleSearch:{}}], toolConfig:{ retrievalConfig:{ languageCode:"ja-JP", latLng:{...} } } } })`。
- `groundingChunks[].web.uri` は `https://vertexaisearch.cloud.google.com/grounding-api-redirect/...` のリダイレクト URL で実 URL ではない。`web.title` が実質ホスト名（例 `meguru-kaitori.jp`）。SDK 型の `web.domain` は「Gemini API では非対応」。geo-scan は title をドメインとして使う。
- `groundingSupports[].segment.startIndex/endIndex` は UTF-8 バイト位置（JS の文字位置ではない）。
- Gemini 3 系は thinking モデルで `thoughtsTokenCount` が出力単価で課金される。
- 料金: `gemini-3.5-flash` in $1.50 / out $9.00。グラウンディングは **Gemini 3 系: 検索クエリ単位で $14/1,000、月 5,000 クエリまで無料（Gemini 3 系合算）**。Gemini 2.5 系は **プロンプト単位で $35/1,000、Flash 系は 1 日 1,500 回まで無料**。検索で取得したコンテキストは入力トークンに課金されない。代替: `gemini-3.6-flash` / `gemini-3.7-flash`（2026-12-31 まで $0.75/$3.75、以降 $1.50/$7.50）、`gemini-2.5-flash`（$0.30/$2.50）。
- 既定を `gemini-3.5-flash` にしたのは公式 SDK サンプルとクックブックの既定モデルだから。検証では「Gemini アプリの既定は 2026-07-21 に 3.6 Flash に変わった」という検索抜粋もあった（公式ページ未確認）。消費者との一致を優先するなら `GEMINI_MODEL=gemini-3.6-flash`（安い）に切り替える。
- `generateContent` は「Legacy」扱いになり Interactions API（`ai.interactions.create`）が推奨に変わっているが、discovery 上は現役で廃止日はない。
- 確認元: generativelanguage.googleapis.com の discovery（v1beta rev 20260831）、js-genai `src/types.ts`・sdk-samples、Google Cloud 料金ページ。ai.google.dev は取得不可。

## Perplexity（sonar）

- `POST https://api.perplexity.ai/chat/completions`、`Authorization: Bearer`。公式 SDK `@perplexity-ai/perplexity_ai` は fetch の薄いラッパーで ESM-only なので、geo-scan は fetch で同じ body を送る。
- リクエスト: `{ model:"sonar", messages:[{role:"system"},{role:"user"}], web_search_options:{ search_context_size:"medium", user_location:{ country:"JP", region:"Osaka", city:"Osaka" } }, max_tokens }`
- レスポンス: `choices[0].message.content`（文字列）、`search_results[]`（主）、`citations[]`（URL 文字列、後方互換）。`usage.cost.total_cost` にサーバー計算の USD が入るので geo-scan はそれを実費として採用する。
- `/chat/completions`（Sonar API）は「非推奨だが提供継続、廃止日未定」で、Agent API（`POST /v1/agent`、`model:"perplexity/sonar"`、`tools:[{type:"web_search"}]`）が新規推奨。移行時は provider ファイルの差し替えだけで済む構成にしてある。
- 料金 ※snippet: `sonar` in $1 / out $1 ＋ リクエスト料 $5（low）/ $8（medium）/ $12（high）per 1,000。`sonar-pro` は $3/$15 ＋ $6/$10/$14。`web_search_options.search_type:"pro"`（Pro Search）を付けるとリクエスト料が $14〜22/1,000 に上がるので付けない。`sonar-reasoning` は 2025-12-15 に廃止済み。無料枠なし（プリペイド課金）。
- 確認元: 公式 SDK 0.38.5 の生成型 `src/generated/api.ts`、perplexityai/api-platform-developers の移行ガイド。docs.perplexity.ai と api.perplexity.ai は取得不可。

## Anthropic Claude（web_search サーバーツール）

- `@anthropic-ai/sdk` 0.123.0（Node 20+）。`client.messages.create({ model, max_tokens, system, messages, tools:[{ type:"web_search_20260209", name:"web_search", max_uses:3, user_location:{...} }] })`。beta ヘッダー不要。
- ツール版: `web_search_20250305`（基本）、`web_search_20260209`（動的フィルタ、Claude 4.6 以降）、`web_search_20260318`（`response_inclusion` 追加）。`claude-haiku-4-5` は programmatic tool calling 非対応のため 20260209 を使うなら `allowed_callers:["direct"]` が必要 → geo-scan は haiku のとき 20250305 を使う。
- レスポンス: `server_tool_use` → `web_search_tool_result`（`content` が配列なら結果 `{url,title,encrypted_content,page_age}`、オブジェクトならエラー `{error_code}`。HTTP は 200）→ `text` ブロック（`citations[]` に `web_search_result_location {url,title,cited_text,encrypted_index}`）。
- `stop_reason:"pause_turn"` なら assistant の content をそのまま積んで同じ tools で再送（geo-scan は最大 3 回）。usage は全リクエスト分を合算。
- Sonnet 5 の制約: temperature 等の変更は 400、`thinking:{type:"enabled"}` は 400（adaptive が既定）、prefill 不可。拒否は `stop_reason:"refusal"` と `stop_details:{type:"refusal",category}` の両方を見る（HTTP は 200）。トークナイザが変わり同じ文章で Sonnet 4.6 より約 30% 多い。
- 料金: `claude-sonnet-5` in $2 / out $10（値上げは中止で恒久）、web search $10/1,000 searches（エラー時は課金なし）、検索結果は入力トークンとして課金（反復のたびに再カウントされるので `max_uses` で抑える）。`claude-haiku-4-5` $1/$5（抽出用）、`claude-opus-5` $5/$25。
- 確認元: platform.claude.com の web-search-tool.md / about-claude/pricing.md / models/overview.md / sonnet-5、anthropic-sdk-typescript `messages.ts`。

## 共通の注意

- 利用者の位置ヒントは既定で国（JP）とタイムゾーンだけを渡す。市区町村・緯度経度まで渡すと「地域名なしの質問」でも地域に寄った回答になり、計測の意味が変わるため、渡したい場合は `config/targets/<slug>.json` の `searchLocation` で明示する（レポートの計測方法欄に載る）。
- 回答本文は raw JSON に保存するだけで再配布しない。レポートは要約と短い抜粋のみ。
- 各社ともモデルは数か月で入れ替わる。`OPENAI_MODEL` / `GEMINI_MODEL` / `PERPLEXITY_MODEL` / `ANTHROPIC_MODEL` で差し替えられ、料金表にないモデルは既定モデルの単価で概算する（警告を出す）。
- 料金は `src/lib/pricing.ts` に集約。請求と合わなければそこを直す。
