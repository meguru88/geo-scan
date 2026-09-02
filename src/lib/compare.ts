import type { Aggregate } from './aggregate.js';
import { scoreOf, type Mark, type Score } from './score.js';
import { engineLabel } from './types.js';

export interface EngineDiff {
  engine: string;
  label: string;
  before: number | null;
  after: number | null;
  diff: number | null;
}

export interface QuestionChange {
  no: number;
  text: string;
  engine: string;
  label: string;
  before: Mark;
  after: Mark;
}

export interface Comparison {
  beforeDate: string;
  afterDate: string;
  /** 両日に存在するエンジンだけで再計算した総合 */
  commonEngines: string[];
  overall: { before: number; after: number; diff: number };
  mentionRate: { before: number; after: number };
  citeRate: { before: number; after: number };
  byEngine: EngineDiff[];
  /** ×（計測して出なかった）→ ○／△ になった質問×エンジン */
  newlyMentioned: QuestionChange[];
  /** ○／△ → ×（計測して出なかった）になった質問×エンジン */
  lost: QuestionChange[];
  /** 今回から計測を始めたエンジン／今回は計測していないエンジン */
  onlyAfter: string[];
  onlyBefore: string[];
  /** 質問文が前回と違う（比較対象から外した）質問番号 */
  changedQuestions: { no: number; before: string; after: string }[];
}

const SHOWN: Mark[] = ['○', '△'];
const MEASURED: Mark[] = ['○', '△', '×'];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pooled(agg: Aggregate, engines: string[]): Score {
  return scoreOf(agg.extractions.filter((x) => engines.includes(x.engine)));
}

export function buildComparison(before: Aggregate, after: Aggregate): Comparison {
  const commonEngines = after.engines.filter((e) => before.engines.includes(e));
  const onlyAfter = after.engines.filter((e) => !before.engines.includes(e));
  const onlyBefore = before.engines.filter((e) => !after.engines.includes(e));

  const byEngine: EngineDiff[] = [...after.engines, ...onlyBefore].map((e) => {
    const b = before.byEngine.find((x) => x.engine === e)?.total ?? null;
    const a = after.byEngine.find((x) => x.engine === e)?.total ?? null;
    return { engine: e, label: engineLabel(e), before: b, after: a, diff: a !== null && b !== null ? round1(a - b) : null };
  });

  const bScore = pooled(before, commonEngines);
  const aScore = pooled(after, commonEngines);

  const newlyMentioned: QuestionChange[] = [];
  const lost: QuestionChange[] = [];
  const changedQuestions: Comparison['changedQuestions'] = [];
  for (const row of after.questionRows) {
    const prev = before.questionRows.find((r) => r.no === row.no);
    if (!prev) continue;
    if (prev.text.trim() !== row.text.trim()) {
      changedQuestions.push({ no: row.no, before: prev.text, after: row.text });
      continue;
    }
    for (const e of commonEngines) {
      const a = row.cells[e]?.mark ?? '－';
      const b = prev.cells[e]?.mark ?? '－';
      if (!MEASURED.includes(a) || !MEASURED.includes(b)) continue;
      const change = { no: row.no, text: row.text, engine: e, label: engineLabel(e), before: b, after: a };
      if (!SHOWN.includes(b) && SHOWN.includes(a)) newlyMentioned.push(change);
      else if (SHOWN.includes(b) && !SHOWN.includes(a)) lost.push(change);
    }
  }

  return {
    beforeDate: before.date,
    afterDate: after.date,
    commonEngines,
    overall: { before: bScore.total, after: aScore.total, diff: round1(aScore.total - bScore.total) },
    mentionRate: { before: bScore.mentionRate, after: aScore.mentionRate },
    citeRate: { before: bScore.citeRate, after: aScore.citeRate },
    byEngine,
    newlyMentioned,
    lost,
    onlyAfter,
    onlyBefore,
    changedQuestions,
  };
}
