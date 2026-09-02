import Anthropic from '@anthropic-ai/sdk';
import { domainOf } from '../lib/config.js';
import type { Citation } from '../lib/types.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

const MAX_CONTINUATIONS = 3;
const MAX_SEARCHES = 3;

const USER_LOCATION: Anthropic.UserLocation = { type: 'approximate', country: 'JP', city: 'Osaka', region: 'Osaka', timezone: 'Asia/Tokyo' };

/**
 * web_search ツールの定義。動的フィルタ版（20260209）は Claude 4.6 以降向けで、
 * claude-haiku-4-5 は programmatic tool calling 非対応のため基本版（20250305）を使う。
 */
function webSearchTool(model: string): Anthropic.ToolUnion {
  if (/haiku/i.test(model)) {
    return { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, user_location: USER_LOCATION };
  }
  return { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES, user_location: USER_LOCATION };
}

/**
 * Claude Messages API + web_search サーバーツール。
 * 引用は text ブロックの citations[]（web_search_result_location）から取る。
 */
export function createAnthropicProvider(apiKey: string, model: string): Provider {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 180_000 });
  const tools = [webSearchTool(model)];

  return {
    engine: 'anthropic',
    model,
    async ask(question: string): Promise<AskResult> {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
      const responses: Anthropic.Message[] = [];

      for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
        const res = await client.messages.create({ model, max_tokens: 4096, system: SYSTEM_PROMPT, messages, tools });
        responses.push(res);
        if (res.stop_reason === 'refusal') {
          throw new Error(`Claude が応答を拒否しました (${res.stop_details?.category ?? 'unknown'})`);
        }
        // サーバーツールの反復上限で一時停止した場合は、応答をそのまま積んで同じ tools で続きを求める
        if (res.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS) {
          messages.push({ role: 'assistant', content: res.content });
          continue;
        }
        break;
      }

      const textParts: string[] = [];
      const citations: Citation[] = [];
      const seen = new Set<string>();
      let inputTokens = 0;
      let outputTokens = 0;
      let searches = 0;
      for (const res of responses) {
        inputTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        outputTokens += res.usage.output_tokens;
        searches += res.usage.server_tool_use?.web_search_requests ?? 0;
        for (const block of res.content) {
          if (block.type !== 'text') continue;
          textParts.push(block.text);
          for (const c of block.citations ?? []) {
            if (c.type !== 'web_search_result_location' || seen.has(c.url)) continue;
            const domain = domainOf(c.url);
            if (!domain) continue;
            seen.add(c.url);
            citations.push({ url: c.url, domain, title: c.title ?? undefined });
          }
        }
      }

      const last = responses[responses.length - 1];
      return {
        text: textParts.join(''),
        citations,
        usage: { inputTokens, outputTokens, searches },
        model: last?.model ?? model,
        raw: responses.length === 1 ? responses[0] : responses,
      };
    },
  };
}
