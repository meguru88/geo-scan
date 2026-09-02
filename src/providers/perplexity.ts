import { domainOf } from '../lib/config.js';
import type { Citation } from '../lib/types.js';
import type { SearchLocation } from './location.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

/**
 * Sonar API（OpenAI 互換の chat/completions）。「非推奨だが提供継続、廃止日未定」で、
 * 新規推奨の Agent API（POST /v1/agent）に移る場合はこのファイルだけ差し替える。
 */
const ENDPOINT = 'https://api.perplexity.ai/chat/completions';

interface PerplexityResponse {
  id?: string;
  model?: string;
  choices?: { message?: { role?: string; content?: string | { type?: string; text?: string }[] | null }; finish_reason?: string | null }[];
  /** 主: {title, url, date, last_updated, snippet, source} */
  search_results?: { title?: string; url?: string; date?: string | null; snippet?: string }[] | null;
  /** 後方互換: URL 文字列の配列 */
  citations?: string[] | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    num_search_queries?: number | null;
    search_context_size?: string | null;
    /** サーバー計算の USD */
    cost?: { input_tokens_cost?: number; output_tokens_cost?: number; request_cost?: number | null; total_cost?: number } | null;
  };
}

export class PerplexityHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Perplexity API ${status}: ${body.slice(0, 500)}`);
    this.name = 'PerplexityHttpError';
  }
}

export function createPerplexityProvider(apiKey: string, model: string, location: SearchLocation): Provider {
  const userLocation = {
    country: location.country,
    ...(location.region ? { region: location.region } : {}),
    ...(location.city ? { city: location.city } : {}),
  };

  return {
    engine: 'perplexity',
    model,
    async ask(question: string): Promise<AskResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: question },
            ],
            web_search_options: { search_context_size: 'medium', user_location: userLocation },
            max_tokens: 2048,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const bodyText = await res.text();
      if (!res.ok) throw new PerplexityHttpError(res.status, bodyText);
      const json = JSON.parse(bodyText) as PerplexityResponse;

      const content = json.choices?.[0]?.message?.content;
      const text = typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('');
      if (!text.trim()) throw new Error('Perplexity returned an empty answer');

      const citations: Citation[] = [];
      const seen = new Set<string>();
      const push = (url: string | undefined, title?: string) => {
        if (!url || seen.has(url)) return;
        const domain = domainOf(url);
        if (!domain) return;
        seen.add(url);
        citations.push({ url, domain, title });
      };
      for (const r of json.search_results ?? []) push(r.url, r.title);
      if (citations.length === 0) for (const u of json.citations ?? []) push(u);

      const serverCost = json.usage?.cost?.total_cost;
      return {
        text,
        citations,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          // 課金は 1 リクエスト単位
          searches: 1,
        },
        model: json.model ?? model,
        raw: json,
        ...(typeof serverCost === 'number' ? { costUsd: serverCost } : {}),
      };
    },
  };
}
