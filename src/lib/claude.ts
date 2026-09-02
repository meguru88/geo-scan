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

/** モデルごとに output_config.format が使えるかを記憶（未対応なら1回だけ失敗してフォールバック） */
const formatUnsupported = new Set<string>();

/** Claude に JSON で答えさせて parse する */
export async function askJson<T>(opts: JsonAsk): Promise<JsonAskResult<T>> {
  const c = anthropicClient();
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
  };
  const outputConfig: Anthropic.OutputConfig = {};
  if (opts.effort) outputConfig.effort = opts.effort;

  let res: Anthropic.Message;
  if (!formatUnsupported.has(opts.model)) {
    try {
      res = await c.messages.create({
        ...base,
        output_config: { ...outputConfig, format: { type: 'json_schema', schema: opts.schema } },
      });
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      formatUnsupported.add(opts.model);
      res = await c.messages.create({ ...base, ...(opts.effort ? { output_config: outputConfig } : {}) });
    }
  } else {
    res = await c.messages.create({ ...base, ...(opts.effort ? { output_config: outputConfig } : {}) });
  }

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
