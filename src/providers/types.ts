import type { Citation, Engine, TokenUsage } from '../lib/types.js';

/** 全エンジン共通のシステムプロンプト。誘導しない */
export const SYSTEM_PROMPT = '日本語で、具体的な業者名を挙げて答えてください';

export interface AskResult {
  text: string;
  citations: Citation[];
  usage: TokenUsage;
  /** 実際に使われたモデル名 */
  model: string;
  /** プロバイダのレスポンス全体（保存用） */
  raw: unknown;
}

/** 呼び出し側のメタ情報。実プロバイダは無視してよい（モックが回答の揺らぎに使う） */
export interface AskMeta {
  questionNo: number;
  runIndex: number;
}

export interface Provider {
  engine: Engine;
  model: string;
  ask(question: string, meta: AskMeta): Promise<AskResult>;
}

export interface ProviderContext {
  slug: string;
  date: string;
  /** モックの乱数シード */
  seed: string;
}
