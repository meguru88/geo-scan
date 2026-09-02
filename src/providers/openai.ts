import { domainOf } from '../lib/config.js';
import type { Citation } from '../lib/types.js';
import type { SearchLocation } from './location.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';

/**
 * Responses API のレスポンスのうち使う部分だけの型。
 * openai@7 は Node 22 必須のため、Node 20 でも動くよう fetch で直接呼ぶ（フィールド名は OpenAPI 仕様どおり）。
 */
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface UrlCitation {
  type: 'url_citation';
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface OutputText {
  type: 'output_text';
  text: string;
  annotations?: ({ type: string } | UrlCitation)[];
}

interface RefusalPart {
  type: 'refusal';
  refusal?: string;
}

interface OutputMessage {
  type: 'message';
  role?: string;
  content?: ({ type: string } | OutputText | RefusalPart)[];
}

interface WebSearchCall {
  type: 'web_search_call';
  status?: string;
  action?: { type?: string; queries?: string[]; query?: string; sources?: { type?: string; url?: string }[] };
}

type OutputItem = OutputMessage | WebSearchCall | { type: string };

interface ResponsesResponse {
  id?: string;
  status?: string;
  model?: string;
  output?: OutputItem[];
  usage?: ResponsesUsage;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export class OpenAIHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`OpenAI API ${status}: ${body.slice(0, 500)}`);
    this.name = 'OpenAIHttpError';
  }
}

/** 引用 URL の ?utm_source=chatgpt.com などを落とす（比較・重複除去用。元 URL は providerRaw に残る） */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.toLowerCase().startsWith('utm_')) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

export function createOpenAIProvider(apiKey: string, model: string, location: SearchLocation): Provider {
  const effort = process.env.OPENAI_REASONING_EFFORT?.trim() || 'low';
  const userLocation = {
    type: 'approximate',
    country: location.country,
    ...(location.city ? { city: location.city } : {}),
    ...(location.region ? { region: location.region } : {}),
    ...(location.timezone ? { timezone: location.timezone } : {}),
  };

  return {
    engine: 'openai',
    model,
    async ask(question: string): Promise<AskResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            instructions: SYSTEM_PROMPT,
            input: question,
            tools: [{ type: 'web_search', search_context_size: 'medium', user_location: userLocation }],
            include: ['web_search_call.action.sources'],
            ...(effort === 'none' ? {} : { reasoning: { effort } }),
            max_output_tokens: 6000,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const bodyText = await res.text();
      if (!res.ok) throw new OpenAIHttpError(res.status, bodyText);
      const json = JSON.parse(bodyText) as ResponsesResponse;
      if (json.error) throw new Error(`OpenAI response error: ${json.error.message ?? json.error.code ?? 'unknown'}`);
      if (json.status !== 'completed') {
        throw new Error(`OpenAI response ${json.status ?? 'unknown'}${json.incomplete_details?.reason ? ` (${json.incomplete_details.reason})` : ''}`);
      }

      const texts: string[] = [];
      const citations: Citation[] = [];
      const seen = new Set<string>();
      let searches = 0;
      for (const item of json.output ?? []) {
        if (item.type === 'web_search_call') {
          searches++;
          continue;
        }
        if (item.type !== 'message') continue;
        for (const part of (item as OutputMessage).content ?? []) {
          if (part.type === 'refusal') throw new Error(`OpenAI refusal: ${(part as RefusalPart).refusal ?? ''}`.slice(0, 300));
          if (part.type !== 'output_text') continue;
          const ot = part as OutputText;
          texts.push(ot.text);
          for (const a of ot.annotations ?? []) {
            if (a.type !== 'url_citation') continue;
            const url = cleanUrl((a as UrlCitation).url);
            if (seen.has(url)) continue;
            const domain = domainOf(url);
            if (!domain) continue;
            seen.add(url);
            citations.push({ url, domain, title: (a as UrlCitation).title });
          }
        }
      }
      const text = texts.join('');
      if (!text.trim()) throw new Error('OpenAI returned an empty answer');

      return {
        text,
        citations,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
          searches,
        },
        model: json.model ?? model,
        raw: json,
      };
    },
  };
}
