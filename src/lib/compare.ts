import type { Aggregate } from './aggregate.js';
import type { Mark } from './score.js';
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
  overall: { before: number; after: number; diff: number };
  mentionRate: { before: number; after: number };
  citeRate: { before: number; after: number };
  byEngine: EngineDiff[];
  /** ×／－ → ○／△ になった質問×エンジン */
  newlyMentioned: QuestionChange[];
  /** ○／△ → ×／－ になった質問×エンジン */
  lost: QuestionChange[];
}

const SHOWN: Mark[] = ['○', '△'];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildComparison(before: Aggregate, after: Aggregate): Comparison {
  const engines = [...new Set([...after.engines, ...before.engines])];
  const byEngine: EngineDiff[] = engines.map((e) => {
    const b = before.byEngine.find((x) => x.engine === e)?.total ?? null;
    const a = after.byEngine.find((x) => x.engine === e)?.total ?? null;
    return { engine: e, label: engineLabel(e), before: b, after: a, diff: a !== null && b !== null ? round1(a - b) : null };
  });

  const newlyMentioned: QuestionChange[] = [];
  const lost: QuestionChange[] = [];
  for (const row of after.questionRows) {
    const prev = before.questionRows.find((r) => r.no === row.no && r.text === row.text) ?? before.questionRows.find((r) => r.no === row.no);
    for (const e of engines) {
      const a = row.cells[e]?.mark ?? '－';
      const b = prev?.cells[e]?.mark ?? '－';
      const change = { no: row.no, text: row.text, engine: e, label: engineLabel(e), before: b, after: a };
      if (!SHOWN.includes(b) && SHOWN.includes(a)) newlyMentioned.push(change);
      else if (SHOWN.includes(b) && !SHOWN.includes(a)) lost.push(change);
    }
  }

  return {
    beforeDate: before.date,
    afterDate: after.date,
    overall: { before: before.overall.total, after: after.overall.total, diff: round1(after.overall.total - before.overall.total) },
    mentionRate: { before: before.overall.mentionRate, after: after.overall.mentionRate },
    citeRate: { before: before.overall.citeRate, after: after.overall.citeRate },
    byEngine,
    newlyMentioned,
    lost,
  };
}
