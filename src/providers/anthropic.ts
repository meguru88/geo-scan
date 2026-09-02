import Anthropic from '@anthropic-ai/sdk';
import { webSearchTool } from '../lib/claude.js';
import { domainOf } from '../lib/config.js';
import type { Citation } from '../lib/types.js';
import type { SearchLocation } from './location.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

const MAX_CONTINUATIONS = 3;
const MAX_SEARCHES = 3;

/** 検索そのものの失敗（回答は出るが検索なし）。回答を無効にしてリトライさせる */
const FATAL_SEARCH_ERRORS = new Set(['too_many_requests', 'unavailable']);

/**
 * Claude Messages API + web_search サーバーツール。
 * 引用は text ブロックの citations[]（web_search_result_location）から取る。
 */
export function createAnthropicProvider(apiKey: string, model: string, location: SearchLocation): Provider {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 180_000 });
  const tools = [webSearchTool(model, location, MAX_SEARCHES)];

  return {
    engine: 'anthropic',
    model,
    async ask(question: string): Promise<AskResult> {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
      const responses: Anthropic.Message[] = [];

      for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
        const res = await client.messages.create({ model, max_tokens: 4096, system: SYSTEM_PROMPT, messages, tools });
        responses.push(res);
        if (res.stop_reason === 'refusal' || res.stop_details?.type === 'refusal') {
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
      const searchErrors: string[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let searches = 0;
      for (const res of responses) {
        inputTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        outputTokens += res.usage.output_tokens;
        searches += res.usage.server_tool_use?.web_search_requests ?? 0;
        for (const block of res.content) {
          if (block.type === 'web_search_tool_result' && !Array.isArray(block.content)) {
            // HTTP 200 のまま検索だけ失敗したケース
            const code = block.content.error_code;
            if (FATAL_SEARCH_ERRORS.has(code)) throw new Error(`Claude web_search failed: ${code}`);
            searchErrors.push(code);
            continue;
          }
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
      const text = textParts.join('');
      if (!text.trim()) throw new Error('Claude returned an empty answer');

      const last = responses[responses.length - 1];
      return {
        text,
        citations,
        usage: { inputTokens, outputTokens, searches },
        model: last?.model ?? model,
        raw: { responses, ...(searchErrors.length ? { searchErrors } : {}) },
      };
    },
  };
}
