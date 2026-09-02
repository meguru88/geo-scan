import { usdJpyRate } from './env.js';
import type { Engine, TokenUsage } from './types.js';

/**
 * 料金表（USD）。docs/api-notes.md の調査結果に基づく（2026-09-02）。
 * searchFeeUnit: 'search' = 検索1回ごと、'call' = リクエスト1回ごと（検索した場合）
 */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  searchFeeUsd: number;
  searchFeeUnit: 'search' | 'call';
  note?: string;
}

export const PRICING: Record<string, ModelPricing> = {
  // OpenAI (Responses API + web_search): web search $10/1K calls ＋ 検索コンテンツは入力単価
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K calls' },
  'gpt-5-mini': { inputPerMTok: 0.25, outputPerMTok: 2.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K calls' },
  'gpt-5.5': { inputPerMTok: 5.0, outputPerMTok: 30.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K calls（ChatGPT の既定に最も近い）' },
  'gpt-5.6-sol': { inputPerMTok: 4.0, outputPerMTok: 20.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K calls（2026-11-21 までの販促価格）' },
  'gpt-4.1-mini': { inputPerMTok: 0.4, outputPerMTok: 1.6, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K calls ＋ 8,000 入力トークン固定' },
  // Google Gemini: Gemini 3 系は検索クエリ単位 $14/1K（月 5,000 クエリ無料）、2.5 系はプロンプト単位 $35/1K（Flash は 1 日 1,500 回無料）
  'gemini-3.5-flash': { inputPerMTok: 1.5, outputPerMTok: 9.0, searchFeeUsd: 0.014, searchFeeUnit: 'search', note: 'grounding $14/1K クエリ（月 5,000 クエリまで無料）' },
  'gemini-3.7-flash': { inputPerMTok: 0.75, outputPerMTok: 3.75, searchFeeUsd: 0.014, searchFeeUnit: 'search', note: 'grounding $14/1K クエリ、2026-12-31 まで導入価格' },
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5, searchFeeUsd: 0.014, searchFeeUnit: 'search', note: 'grounding $14/1K クエリ' },
  'gemini-3.1-pro-preview': { inputPerMTok: 2.0, outputPerMTok: 12.0, searchFeeUsd: 0.014, searchFeeUnit: 'search', note: 'grounding $14/1K クエリ' },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5, searchFeeUsd: 0.035, searchFeeUnit: 'call', note: 'grounding $35/1K prompts（1 日 1,500 回まで無料）' },
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10.0, searchFeeUsd: 0.035, searchFeeUnit: 'call', note: 'grounding $35/1K prompts' },
  // Perplexity (sonar): リクエスト料は search_context_size=medium の値
  sonar: { inputPerMTok: 1.0, outputPerMTok: 1.0, searchFeeUsd: 0.008, searchFeeUnit: 'call', note: 'request fee $8/1K (medium)' },
  'sonar-pro': { inputPerMTok: 3.0, outputPerMTok: 15.0, searchFeeUsd: 0.01, searchFeeUnit: 'call', note: 'request fee $10/1K (medium)' },
  'sonar-reasoning-pro': { inputPerMTok: 2.0, outputPerMTok: 8.0, searchFeeUsd: 0.01, searchFeeUnit: 'call', note: 'request fee $10/1K (medium)' },
  // Anthropic: web search $10/1K searches
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K searches' },
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K searches' },
  'claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K searches' },
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0, searchFeeUsd: 0.01, searchFeeUnit: 'search', note: 'web search $10/1K searches' },
};

export const DEFAULT_MODELS: Record<Engine, string> = {
  openai: 'gpt-5.4-mini',
  gemini: 'gemini-3.5-flash',
  perplexity: 'sonar',
  anthropic: 'claude-sonnet-5',
};

const MODEL_ENV: Record<Engine, string> = {
  openai: 'OPENAI_MODEL',
  gemini: 'GEMINI_MODEL',
  perplexity: 'PERPLEXITY_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
};

export function modelFor(engine: Engine): string {
  return process.env[MODEL_ENV[engine]]?.trim() || DEFAULT_MODELS[engine];
}

const warned = new Set<string>();

/** モデルの料金。未知のモデルはエンジンの既定モデルの料金で代用（警告を1回出す） */
export function pricingFor(engine: Engine, model: string): ModelPricing {
  const exact = PRICING[model];
  if (exact) return exact;
  const fallback = PRICING[DEFAULT_MODELS[engine]]!;
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`注意: ${model} の料金が料金表にないため ${DEFAULT_MODELS[engine]} の料金で概算します（src/lib/pricing.ts）`);
  }
  return fallback;
}

/**
 * 1回の質問で使うと仮定するトークン量（エンジンごと。docs/api-notes.md の概算根拠）。
 * OpenAI/Claude は検索結果がコンテキストに入るので入力が多く、Gemini は検索コンテキストが課金されない代わりに思考トークンが出力に乗る。
 */
export const ASSUMED_USAGE: Record<Engine, TokenUsage> = {
  openai: { inputTokens: 10000, outputTokens: 2300, searches: 1.5 },
  gemini: { inputTokens: 500, outputTokens: 2000, searches: 2 },
  perplexity: { inputTokens: 1500, outputTokens: 600, searches: 1 },
  anthropic: { inputTokens: 15000, outputTokens: 2000, searches: 2 },
};

export function costUsd(engine: Engine, model: string, usage: TokenUsage): number {
  const p = pricingFor(engine, model);
  const tokens = (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
  const searchUnits = p.searchFeeUnit === 'call' ? (usage.searches > 0 ? 1 : 0) : usage.searches;
  return tokens + searchUnits * p.searchFeeUsd;
}

export function estimateCallUsd(engine: Engine, model: string): number {
  return costUsd(engine, model, ASSUMED_USAGE[engine]);
}

/** 抽出（Haiku）1回あたりの概算: 入力 ~2,000 / 出力 ~400 トークン */
export function estimateExtractUsd(model: string): number {
  const p = PRICING[model] ?? PRICING['claude-haiku-4-5']!;
  return (2000 * p.inputPerMTok + 400 * p.outputPerMTok) / 1_000_000;
}

export function toJpy(usd: number): number {
  return usd * usdJpyRate();
}

export function yen(usd: number): string {
  return `¥${toJpy(usd).toFixed(1)}`;
}
