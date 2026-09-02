import Anthropic from '@anthropic-ai/sdk';

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
