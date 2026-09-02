import type { BusinessMention, Extraction, TargetConfig } from './types.js';

/** 依存なしの CSV パーサ（ダブルクォート・改行・BOM 対応） */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ManualRow {
  line: number;
  date: string;
  engine: string;
  questionNo: number;
  mentioned: boolean;
  rank: number | null;
  citedOwn: boolean;
  competitors: string[];
  notes: string;
}

const REQUIRED = ['date', 'engine', 'question_no', 'mentioned'];

function parseBool(v: string, field: string, line: number): boolean {
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', '○', '◯', 'o'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', '×', 'x', ''].includes(s)) return false;
  throw new Error(`${line} 行目: ${field} は 0/1 で指定してください（指定値: ${v}）`);
}

/** CSV 文字列を検証済みの行に変換する */
export function parseManualCsv(text: string): ManualRow[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('CSV が空です');
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const r of REQUIRED) if (!cols.includes(r)) throw new Error(`CSV に列 "${r}" がありません（必要な列: date, engine, question_no, mentioned, rank, cited_own, competitors, notes）`);
  const idx = (name: string) => cols.indexOf(name);
  const get = (row: string[], name: string) => {
    const i = idx(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const out: ManualRow[] = [];
  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const date = get(row, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${line} 行目: date は YYYY-MM-DD 形式で指定してください（指定値: ${date}）`);
    const engine = get(row, 'engine').toLowerCase().replace(/[\s-]+/g, '_');
    if (!/^[a-z0-9_]+$/.test(engine)) throw new Error(`${line} 行目: engine は英数字と _ で指定してください（例: google_aio, google_aimode）`);
    const qn = Number(get(row, 'question_no'));
    if (!Number.isInteger(qn) || qn < 1) throw new Error(`${line} 行目: question_no は 1 以上の整数で指定してください`);
    const mentioned = parseBool(get(row, 'mentioned'), 'mentioned', line);
    const rankRaw = get(row, 'rank');
    let rank: number | null = null;
    if (rankRaw !== '' && rankRaw !== '-') {
      const r = Number(rankRaw);
      if (!Number.isInteger(r) || r < 1) throw new Error(`${line} 行目: rank は 1 以上の整数か空欄にしてください`);
      rank = r;
    }
    if (!mentioned) rank = null;
    const citedOwn = parseBool(get(row, 'cited_own'), 'cited_own', line);
    const competitors = get(row, 'competitors')
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ line, date, engine, questionNo: qn, mentioned, rank, citedOwn, competitors, notes: get(row, 'notes') });
  });
  return out;
}

/** 手動行を Extraction に変換する。runIndex は同じ (date, engine, question_no) 内の連番 */
export function manualRowToExtraction(row: ManualRow, runIndex: number, target: TargetConfig, ownDomain: string): Extraction {
  const businesses: BusinessMention[] = row.competitors.map((name) => ({ name, isTarget: false, reason: '' }));
  if (row.mentioned) {
    const pos = row.rank ? Math.min(Math.max(row.rank - 1, 0), businesses.length) : businesses.length;
    businesses.splice(pos, 0, { name: target.name, isTarget: true, reason: '' });
  }
  const id = `${row.engine}-q${String(row.questionNo).padStart(2, '0')}-r${runIndex}`;
  return {
    id,
    engine: row.engine,
    questionNo: row.questionNo,
    runIndex,
    status: 'ok',
    source: 'manual',
    mentioned: row.mentioned,
    rank: row.mentioned ? row.rank : null,
    citedOwnSite: row.citedOwn,
    competitorsMentioned: row.competitors,
    businesses,
    citedDomains: row.citedOwn ? [ownDomain] : [],
    method: 'manual',
    ...(row.notes ? { notes: row.notes } : {}),
    extractedAt: new Date().toISOString(),
  };
}
