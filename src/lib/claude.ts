import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LOCATION, type SearchLocation } from '../providers/location.js';

let client: Anthropic | null = null;

export function anthropicClient(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 2, timeout: 180_000 });
  return client;
}

/** 質問生成・改善提案に使うモデル */
export function writerModel(): string {
  return process.env.ANTHROPIC_WRITER_MODEL?.trim() || 'claude-opus-5';
}

/** 抽出（回答ごとに120回呼ぶ）に使う安価なモデル */
export function extractModel(): string {
  return process.env.ANTHROPIC_EXTRACT_MODEL?.trim() || 'claude-haiku-4-5';
}

export interface JsonAsk {
  model: string;
  system: string;
  user: string;
  /** JSON Schema（structured outputs 用。未対応モデルではプロンプトのみで代替） */
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface JsonAskResult<T> {
  value: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** モデルごとに使えなかった機能を記憶（未対応なら1回だけ失敗してフォールバック） */
const formatUnsupported = new Set<string>();
const effortUnsupported = new Set<string>();

function buildParams(opts: JsonAsk): Anthropic.MessageCreateParamsNonStreaming {
  const outputConfig: Anthropic.OutputConfig = {};
  if (opts.effort && !effortUnsupported.has(opts.model)) outputConfig.effort = opts.effort;
  if (!formatUnsupported.has(opts.model)) outputConfig.format = { type: 'json_schema', schema: opts.schema };
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

/** Claude に JSON で答えさせて parse する */
export async function askJson<T>(opts: JsonAsk): Promise<JsonAskResult<T>> {
  const c = anthropicClient();
  let res: Anthropic.Message | null = null;
  // 400 の原因（structured outputs 非対応 / effort 非対応）を見て、その機能だけ外して再試行する
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      res = await c.messages.create(buildParams(opts));
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      const msg = err.message;
      if (/output_config\.format|json_schema|structured/i.test(msg) && !formatUnsupported.has(opts.model)) {
        formatUnsupported.add(opts.model);
        console.warn(`注意: ${opts.model} は structured outputs 非対応のため、プロンプトのみで JSON を求めます（${msg.slice(0, 120)}）`);
        continue;
      }
      if (/effort/i.test(msg) && !effortUnsupported.has(opts.model)) {
        effortUnsupported.add(opts.model);
        continue;
      }
      throw err;
    }
  }
  if (!res) throw new Error('Claude API の呼び出しに失敗しました');

  if (res.stop_reason === 'refusal' || res.stop_details?.type === 'refusal') {
    throw new Error(`Claude が応答を拒否しました (${res.stop_details?.category ?? 'unknown'})`);
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('Claude の出力が max_tokens で途切れました');
  }
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    value: parseJsonLoose<T>(text),
    model: res.model,
    usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
  };
}

/** 動的フィルタ版（web_search_20260209）が使えるモデル: Claude 4.6 以降 */
function supportsDynamicFiltering(model: string): boolean {
  return /claude-(opus|sonnet)-(4-[6-9]|5)(-|$)/.test(model) || /claude-(fable|mythos)-/.test(model);
}

/** web_search ツールの定義。古い世代と haiku は基本版（20250305） */
export function webSearchTool(model: string, location: SearchLocation = DEFAULT_LOCATION, maxUses = 3): Anthropic.ToolUnion {
  const user_location: Anthropic.UserLocation = {
    type: 'approximate',
    country: location.country,
    ...(location.city ? { city: location.city } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.timezone ? { timezone: location.timezone } : {}),
  };
  const override = process.env.ANTHROPIC_WEB_SEARCH_TOOL?.trim();
  const type =
    override === 'web_search_20250305' || override === 'web_search_20260209'
      ? override
      : supportsDynamicFiltering(model)
        ? 'web_search_20260209'
        : 'web_search_20250305';
  return { type, name: 'web_search', max_uses: maxUses, user_location };
}

export interface WebSearchAsk {
  model: string;
  system: string;
  user: string;
  maxUses?: number;
  maxTokens?: number;
  /** サーバーツールが一時停止したときに続きを求める回数 */
  maxContinuations?: number;
}

export interface WebSearchAskResult {
  text: string;
  model: string;
  searches: number;
  /** 回答が引用したドメイン（重複除去） */
  citedDomains: string[];
}

/** 検索エラー（HTTP 200 で返る）のうち、結果が得られないもの */
const FATAL_SEARCH_ERRORS = new Set(['too_many_requests', 'unavailable']);

/** Web 検索を有効にして Claude に聞き、本文をつないで返す */
export async function askWithWebSearch(opts: WebSearchAsk): Promise<WebSearchAskResult> {
  const c = anthropicClient();
  const maxContinuations = opts.maxContinuations ?? 3;
  const tools = [webSearchTool(opts.model, DEFAULT_LOCATION, opts.maxUses ?? 3)];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.user }];
  const texts: string[] = [];
  const domains = new Set<string>();
  let searches = 0;
  let model = opts.model;

  for (let i = 0; i <= maxContinuations; i++) {
    const res = await c.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages,
      tools,
    });
    model = res.model;
    if (res.stop_reason === 'refusal' || res.stop_details?.type === 'refusal') {
      throw new Error(`Claude が応答を拒否しました (${res.stop_details?.category ?? 'unknown'})`);
    }
    searches += res.usage.server_tool_use?.web_search_requests ?? 0;
    for (const block of res.content) {
      if (block.type === 'web_search_tool_result' && !Array.isArray(block.content)) {
        const code = block.content.error_code;
        if (FATAL_SEARCH_ERRORS.has(code)) throw new Error(`Claude の web_search が失敗しました: ${code}`);
        continue;
      }
      if (block.type !== 'text') continue;
      texts.push(block.text);
      for (const cite of block.citations ?? []) {
        if (cite.type !== 'web_search_result_location') continue;
        try {
          domains.add(new URL(cite.url).hostname.replace(/^www\./, ''));
        } catch {
          // URL として読めない引用は無視する
        }
      }
    }
    // サーバーツールの反復上限で止まった場合は、応答をそのまま積んで続きを求める
    if (res.stop_reason === 'pause_turn' && i < maxContinuations) {
      messages.push({ role: 'assistant', content: res.content });
      continue;
    }
    break;
  }

  const text = texts.join('');
  if (!text.trim()) throw new Error('Claude から本文が返りませんでした');
  return { text, model, searches, citedDomains: [...domains] };
}

/** ```json フェンスや前後の説明文が混ざっていても JSON 部分だけを取り出して parse する */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = Math.min(...['{', '['].map((ch) => candidate.indexOf(ch)).filter((i) => i >= 0));
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (!Number.isFinite(start) || end <= start) throw new Error(`JSON を取り出せません: ${candidate.slice(0, 200)}`);
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  }
}
