/** 自動計測するエンジン */
export type Engine = 'openai' | 'gemini' | 'perplexity' | 'anthropic';
export const ENGINES: readonly Engine[] = ['openai', 'gemini', 'perplexity', 'anthropic'];

export function isEngine(s: string): s is Engine {
  return (ENGINES as readonly string[]).includes(s);
}

/** `--engines openai,gemini` を解釈する。未指定なら全エンジン（scan と add で同じ解釈にするため共通化） */
export function parseEngines(value: string | undefined): Engine[] {
  if (value === undefined) return [...ENGINES];
  const out: Engine[] = [];
  for (const e of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isEngine(e)) throw new Error(`不明なエンジン: ${e}（指定できるのは ${ENGINES.join(', ')}）`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0) throw new Error('--engines が空です');
  return out;
}

/** 表示名。手動取り込み（Google AI Overviews など）のエンジン名も含む */
const ENGINE_LABELS: Record<string, string> = {
  openai: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  anthropic: 'Claude',
  google_aio: 'Google AI Overviews',
  google_aimode: 'Google AIモード',
};

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

/** config/targets/<slug>.json */
export interface TargetConfig {
  slug: string;
  name: string;
  aliases: string[];
  url: string;
  industry: string;
  area: string;
  areaAliases: string[];
  competitors: string[];
  /**
   * 検索エンジンに渡す利用者位置のヒント（任意）。既定は国 JP とタイムゾーンのみ。
   * 例: { "city": "Osaka", "region": "Osaka", "latitude": 34.6937, "longitude": 135.5023 }
   */
  searchLocation?: {
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
    latitude?: number;
    longitude?: number;
  };
  /**
   * 改善提案の前に掲載の有無を確かめる第三者サイト（任意）。
   * 省略すると Google ビジネスプロフィール ＋ 業種に応じた主要サイト（不動産なら SUUMO / LIFULL HOME'S / at home など）
   */
  listingSites?: string[];
}

export interface Question {
  no: number;
  text: string;
  /** 地域名を含む質問か */
  withArea: boolean;
}

/** config/questions/<slug>.json */
export interface QuestionSet {
  slug: string;
  generatedAt: string;
  source: 'seed' | 'claude' | 'mock';
  model?: string;
  questions: Question[];
}

export interface Citation {
  url: string;
  /** www. を除いたホスト名 */
  domain: string;
  title?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Web検索の回数（課金単位） */
  searches: number;
}

/** runs/<slug>/<date>/raw/<id>.json */
export interface RawAnswer {
  id: string;
  slug: string;
  date: string;
  engine: string;
  model: string;
  questionNo: number;
  question: string;
  runIndex: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  attempts: number;
  status: 'ok' | 'error';
  error?: string;
  text: string;
  citations: Citation[];
  usage: TokenUsage;
  costUsd: number;
  costJpy: number;
  /** プロバイダのレスポンスをそのまま保存（APIキーは含まれない） */
  providerRaw?: unknown;
}

export interface BusinessMention {
  name: string;
  isTarget: boolean;
  /** 回答文から抜き出した「選ばれた理由」1行 */
  reason: string;
}

/** runs/<slug>/<date>/extracted/<id>.json と manual/<id>.json */
export interface Extraction {
  id: string;
  engine: string;
  questionNo: number;
  runIndex: number;
  status: 'ok' | 'error';
  source: 'scan' | 'manual';
  mentioned: boolean;
  rank: number | null;
  citedOwnSite: boolean;
  competitorsMentioned: string[];
  /** 回答に出てきた業者を出現順に */
  businesses: BusinessMention[];
  citedDomains: string[];
  method: 'regex+claude' | 'regex' | 'manual';
  model?: string;
  notes?: string;
  extractedAt: string;
}
