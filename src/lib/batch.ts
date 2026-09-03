import { assertSlug } from './config.js';
import { parseCsv } from './manual.js';

/** config/batch.csv の 1 行 */
export interface BatchRow {
  line: number;
  slug: string;
  url: string;
  name?: string;
  industry?: string;
  area?: string;
}

const REQUIRED = ['slug', 'url'];
const OPTIONAL = ['name', 'industry', 'area'];

/**
 * 一括診断の CSV を検証済みの行に変換する。列: slug, url, name（任意: industry, area）。
 * slug の重複と不正な URL はここで弾く（API を呼ぶ前に全行を検証する）
 */
export function parseBatchCsv(text: string): BatchRow[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error('CSV が空です');
  const cols = header.map((h) => h.trim().toLowerCase());
  for (const r of REQUIRED) {
    if (!cols.includes(r)) throw new Error(`CSV に列 "${r}" がありません（必要な列: slug, url, name。任意: industry, area）`);
  }
  const get = (row: string[], name: string): string => {
    const i = cols.indexOf(name);
    return i >= 0 ? (row[i] ?? '').trim() : '';
  };

  const out: BatchRow[] = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const slug = get(row, 'slug');
    if (!slug) throw new Error(`${line} 行目: slug が空です`);
    try {
      assertSlug(slug);
    } catch (err) {
      throw new Error(`${line} 行目: ${err instanceof Error ? err.message : String(err)}`);
    }
    const dup = seen.get(slug);
    if (dup !== undefined) throw new Error(`${line} 行目: slug "${slug}" が ${dup} 行目と重複しています`);
    seen.set(slug, line);
    const url = get(row, 'url');
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http/https 以外');
    } catch {
      throw new Error(`${line} 行目: url が不正です（指定値: ${url || '(空)'}）`);
    }
    const r: BatchRow = { line, slug, url };
    for (const k of OPTIONAL) {
      const v = get(row, k);
      if (v) r[k as 'name' | 'industry' | 'area'] = v;
    }
    out.push(r);
  });
  if (out.length === 0) throw new Error('CSV にデータ行がありません（ヘッダーのみ）');
  return out;
}

export type BatchStatus = 'ok' | 'failed' | 'skipped';

/** 1 社ぶんの結果 */
export interface BatchResult {
  row: BatchRow;
  status: BatchStatus;
  /** その社で使った実費（円）。未実行なら 0 */
  costJpy: number;
  /** 生成した report.pdf（ROOT からの相対パス）。失敗・未実行なら null */
  pdf: string | null;
  /** 失敗・未実行の理由 */
  reason?: string;
}

/**
 * 次の 1 社を実行してよいか。累計が上限に達していたら止める
 * （実行後に「超えたら止める」と合わせて、ちょうど上限に達した場合も次には進まない）
 */
export function canStartNext(totalJpy: number, maxTotalJpy: number): boolean {
  return totalJpy < maxTotalJpy;
}

/** 実行後に累計が上限を超えたか */
export function exceededBudget(totalJpy: number, maxTotalJpy: number): boolean {
  return totalJpy > maxTotalJpy;
}

function fmtJpy(v: number): string {
  return `¥${v.toFixed(1)}`;
}

/** 最後に出す成功・失敗・未実行の一覧と PDF のパス一覧（1 行ずつ） */
export function formatBatchSummary(results: BatchResult[], totalJpy: number, maxTotalJpy: number): string[] {
  const ok = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const width = Math.max(4, ...results.map((r) => r.row.slug.length));
  const lines: string[] = [];
  lines.push(`■ 一括診断の結果: 成功 ${ok.length} / 失敗 ${failed.length} / 未実行 ${skipped.length}（全 ${results.length} 社）`);
  lines.push(`  合計費用 ${fmtJpy(totalJpy)}（上限 --max-total-cost ¥${maxTotalJpy}）`);
  lines.push('');
  lines.push(`■ 成功 ${ok.length} 社`);
  if (ok.length === 0) lines.push('  （なし）');
  for (const r of ok) lines.push(`  ${r.row.slug.padEnd(width)}  ${fmtJpy(r.costJpy).padStart(9)}  ${r.row.name ?? ''}`.trimEnd());
  lines.push('');
  lines.push(`■ 失敗 ${failed.length} 社`);
  if (failed.length === 0) lines.push('  （なし）');
  for (const r of failed) lines.push(`  ${r.row.slug.padEnd(width)}  ${fmtJpy(r.costJpy).padStart(9)}  ${r.reason ?? ''}`.trimEnd());
  if (skipped.length) {
    lines.push('');
    lines.push(`■ 未実行 ${skipped.length} 社`);
    for (const r of skipped) lines.push(`  ${r.row.slug.padEnd(width)}  ${r.reason ?? ''}`.trimEnd());
  }
  lines.push('');
  lines.push(`■ レポート PDF ${ok.length} 件`);
  if (ok.length === 0) lines.push('  （なし）');
  for (const r of ok) if (r.pdf) lines.push(`  ${r.pdf}`);
  return lines;
}
