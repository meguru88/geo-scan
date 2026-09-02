import fs from 'node:fs';
import path from 'node:path';
import type { ScanMeta } from '../commands/scan.js';
import { ownDomain } from './config.js';
import { namesMatch, normalize } from './extract.js';
import { dateDir, readJsonFiles } from './runs.js';
import { markOf, scoreOf, type Mark, type Score } from './score.js';
import { ENGINES, engineLabel, type Extraction, type Question, type TargetConfig } from './types.js';

export interface EngineScore extends Score {
  engine: string;
  label: string;
  model?: string;
  manual: boolean;
}

export interface QuestionCell {
  engine: string;
  mark: Mark;
  okRuns: number;
  mentionedRuns: number;
  citedRuns: number;
  ranks: number[];
}

export interface QuestionRow {
  no: number;
  text: string;
  cells: Record<string, QuestionCell>;
  mentionedAnywhere: boolean;
}

export interface CompetitorStat {
  name: string;
  /** 言及された回答数 */
  mentions: number;
  byEngine: Record<string, number>;
  /** 回答文から抽出した理由（頻度順、重複除去） */
  reasons: string[];
  isKnownCompetitor: boolean;
}

export interface DomainStat {
  domain: string;
  count: number;
  isOwn: boolean;
  byEngine: Record<string, number>;
}

export interface Aggregate {
  slug: string;
  date: string;
  runDir: string;
  generatedAt: string;
  mock: boolean;
  target: TargetConfig;
  questions: Question[];
  /** 自動エンジン（実行順）＋手動取り込みエンジン */
  engines: string[];
  models: Record<string, string>;
  runsPerEngine: Record<string, number>;
  overall: Score;
  byEngine: EngineScore[];
  questionRows: QuestionRow[];
  competitors: CompetitorStat[];
  domains: DomainStat[];
  totals: { answers: number; ok: number; errors: number; manual: number; scan: number };
  meta?: ScanMeta;
}

export function loadExtractions(slug: string, date: string, runDir: string): { extractions: Extraction[]; meta?: ScanMeta } {
  const scan = readJsonFiles<Extraction>(path.join(runDir, 'extracted')).map((e) => ({ ...e, source: 'scan' as const }));
  const manual = readJsonFiles<Extraction>(path.join(dateDir(slug, date), 'manual')).map((e) => ({ ...e, source: 'manual' as const }));
  const metaFile = path.join(runDir, 'meta.json');
  const meta = fs.existsSync(metaFile) ? (JSON.parse(fs.readFileSync(metaFile, 'utf8')) as ScanMeta) : undefined;
  return { extractions: [...scan, ...manual], meta };
}

function canonicalName(name: string, target: TargetConfig): { name: string; known: boolean } {
  for (const c of target.competitors) if (namesMatch(name, c)) return { name: c, known: true };
  return { name: name.trim(), known: false };
}

export function buildAggregate(input: {
  slug: string;
  date: string;
  runDir: string;
  target: TargetConfig;
  questions: Question[];
  extractions: Extraction[];
  meta?: ScanMeta;
}): Aggregate {
  const { slug, date, runDir, target, questions, extractions, meta } = input;
  const own = ownDomain(target);

  // エンジンの並び: 自動4種の固定順 → その他（手動）は出現順
  const present = new Set(extractions.map((e) => e.engine));
  const engines: string[] = [...ENGINES.filter((e) => present.has(e)), ...[...present].filter((e) => !(ENGINES as readonly string[]).includes(e))];

  const models: Record<string, string> = { ...(meta?.models ?? {}) };
  const runsPerEngine: Record<string, number> = {};
  for (const e of engines) {
    const list = extractions.filter((x) => x.engine === e);
    runsPerEngine[e] = Math.max(0, ...list.map((x) => x.runIndex));
    if (!models[e]) models[e] = list.some((x) => x.source === 'manual') ? '手動取り込み' : '-';
  }

  const byEngine: EngineScore[] = engines.map((e) => {
    const list = extractions.filter((x) => x.engine === e);
    return {
      engine: e,
      label: engineLabel(e),
      model: models[e],
      manual: list.every((x) => x.source === 'manual'),
      ...scoreOf(list),
    };
  });

  const questionRows: QuestionRow[] = questions.map((q) => {
    const cells: Record<string, QuestionCell> = {};
    for (const e of engines) {
      const list = extractions.filter((x) => x.engine === e && x.questionNo === q.no);
      const m = markOf(list);
      cells[e] = {
        engine: e,
        mark: m.mark,
        okRuns: m.okRuns,
        mentionedRuns: m.mentionedRuns,
        citedRuns: list.filter((x) => x.status === 'ok' && x.citedOwnSite).length,
        ranks: list.filter((x) => x.status === 'ok' && x.mentioned && typeof x.rank === 'number').map((x) => x.rank as number),
      };
    }
    return { no: q.no, text: q.text, cells, mentionedAnywhere: Object.values(cells).some((c) => c.mentionedRuns > 0) };
  });

  // 競合: 回答ごとに1回カウント。理由は頻度順
  const compMap = new Map<string, { mentions: number; byEngine: Record<string, number>; reasons: Map<string, number>; known: boolean }>();
  for (const x of extractions) {
    if (x.status !== 'ok') continue;
    const seenInAnswer = new Set<string>();
    const names: { name: string; reason: string }[] = [
      ...x.businesses.filter((b) => !b.isTarget).map((b) => ({ name: b.name, reason: b.reason })),
      ...x.competitorsMentioned.map((n) => ({ name: n, reason: '' })),
    ];
    for (const { name, reason } of names) {
      const canon = canonicalName(name, target);
      if (!canon.name || normalize(canon.name) === normalize(target.name)) continue;
      const key = normalize(canon.name);
      if (seenInAnswer.has(key)) {
        if (reason) {
          const entry = compMap.get(key)!;
          entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
        }
        continue;
      }
      seenInAnswer.add(key);
      const entry = compMap.get(key) ?? { mentions: 0, byEngine: {}, reasons: new Map<string, number>(), known: canon.known };
      entry.mentions++;
      entry.byEngine[x.engine] = (entry.byEngine[x.engine] ?? 0) + 1;
      if (reason) entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
      compMap.set(key, entry);
    }
  }
  const competitors: CompetitorStat[] = [];
  for (const [key, entry] of compMap) {
    // 表示名: 既知競合ならその表記、未知なら最初に見つかった表記
    const displayName = target.competitors.find((c) => normalize(c) === key) ?? findOriginalName(extractions, key) ?? key;
    const reasons = [...entry.reasons.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([r]) => r);
    competitors.push({ name: displayName, mentions: entry.mentions, byEngine: entry.byEngine, reasons, isKnownCompetitor: entry.known });
  }
  competitors.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'ja'));

  // 引用元ドメイン: 回答ごとに1回カウント
  const domMap = new Map<string, DomainStat>();
  for (const x of extractions) {
    if (x.status !== 'ok') continue;
    for (const d of new Set(x.citedDomains)) {
      const entry = domMap.get(d) ?? { domain: d, count: 0, isOwn: d === own || d.endsWith(`.${own}`), byEngine: {} };
      entry.count++;
      entry.byEngine[x.engine] = (entry.byEngine[x.engine] ?? 0) + 1;
      domMap.set(d, entry);
    }
  }
  const domains = [...domMap.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));

  const ok = extractions.filter((x) => x.status === 'ok').length;
  return {
    slug,
    date,
    runDir,
    generatedAt: new Date().toISOString(),
    mock: meta?.mock ?? false,
    target,
    questions,
    engines,
    models,
    runsPerEngine,
    overall: scoreOf(extractions),
    byEngine,
    questionRows,
    competitors,
    domains,
    totals: {
      answers: extractions.length,
      ok,
      errors: extractions.length - ok,
      manual: extractions.filter((x) => x.source === 'manual').length,
      scan: extractions.filter((x) => x.source === 'scan').length,
    },
    ...(meta ? { meta } : {}),
  };
}

function findOriginalName(extractions: Extraction[], key: string): string | undefined {
  for (const x of extractions) {
    for (const b of x.businesses) if (normalize(b.name) === key) return b.name;
    for (const n of x.competitorsMentioned) if (normalize(n) === key) return n;
  }
  return undefined;
}
