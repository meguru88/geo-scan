import type { Extraction } from './types.js';

/** 順位点: 1位=30・2位=20・3位=12・4位以下=5 */
export function rankPoints(rank: number | null): number {
  if (rank === 1) return 30;
  if (rank === 2) return 20;
  if (rank === 3) return 12;
  return 5;
}

export interface Score {
  /** 集計対象（status ok）の回答数 */
  answers: number;
  errors: number;
  mentioned: number;
  cited: number;
  mentionRate: number;
  citeRate: number;
  /** 言及があった回答の平均順位（なければ null） */
  avgRank: number | null;
  /** 言及率 50点 */
  mentionScore: number;
  /** 順位 30点（言及があった回答の平均） */
  rankScore: number;
  /** 自社サイト引用 20点 */
  citeScore: number;
  /** 0〜100 */
  total: number;
}

export function scoreOf(extractions: readonly Extraction[]): Score {
  const ok = extractions.filter((e) => e.status === 'ok');
  const errors = extractions.length - ok.length;
  const mentioned = ok.filter((e) => e.mentioned);
  const cited = ok.filter((e) => e.citedOwnSite);
  if (ok.length === 0) {
    return { answers: 0, errors, mentioned: 0, cited: 0, mentionRate: 0, citeRate: 0, avgRank: null, mentionScore: 0, rankScore: 0, citeScore: 0, total: 0 };
  }
  const mentionRate = mentioned.length / ok.length;
  const citeRate = cited.length / ok.length;
  const rankScore = mentioned.length ? mentioned.reduce((s, e) => s + rankPoints(e.rank), 0) / mentioned.length : 0;
  const ranks = mentioned.map((e) => e.rank).filter((r): r is number => typeof r === 'number');
  const avgRank = ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
  const mentionScore = mentionRate * 50;
  const citeScore = citeRate * 20;
  const total = Math.round((mentionScore + rankScore + citeScore) * 10) / 10;
  return {
    answers: ok.length,
    errors,
    mentioned: mentioned.length,
    cited: cited.length,
    mentionRate,
    citeRate,
    avgRank,
    mentionScore: Math.round(mentionScore * 10) / 10,
    rankScore: Math.round(rankScore * 10) / 10,
    citeScore: Math.round(citeScore * 10) / 10,
    total: Math.min(100, Math.max(0, total)),
  };
}

export type Mark = '○' | '△' | '×' | '－';

/** 質問×エンジンの ○△×。○=全回で言及、△=一部、×=なし、－=有効な回答なし */
export function markOf(extractions: readonly Extraction[]): { mark: Mark; okRuns: number; mentionedRuns: number } {
  const ok = extractions.filter((e) => e.status === 'ok');
  const mentionedRuns = ok.filter((e) => e.mentioned).length;
  if (ok.length === 0) return { mark: '－', okRuns: 0, mentionedRuns: 0 };
  if (mentionedRuns === ok.length) return { mark: '○', okRuns: ok.length, mentionedRuns };
  if (mentionedRuns === 0) return { mark: '×', okRuns: ok.length, mentionedRuns };
  return { mark: '△', okRuns: ok.length, mentionedRuns };
}
