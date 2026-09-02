import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../lib/args.js';
import { loadQuestions, loadTarget, ownDomain } from '../lib/config.js';
import { manualRowToExtraction, parseManualCsv } from '../lib/manual.js';
import { dateDir, ensureDir, rel, writeJson } from '../lib/runs.js';
import { engineLabel, isEngine } from '../lib/types.js';

/**
 * Google AI Overviews / AI モードなど API のないものを手入力 CSV から取り込む。
 * 列: date, engine, question_no, mentioned(0/1), rank, cited_own(0/1), competitors(;区切り), notes
 * 出力: runs/<slug>/<date>/manual/<engine>-qNN-rK.json（同じ date+engine は再取り込みで置き換え）
 */
export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [slug, csvPath] = args.positionals;
  if (!slug || !csvPath) throw new Error('使い方: npm run import-manual -- <slug> <csv>');
  const target = loadTarget(slug);
  const questions = loadQuestions(slug).questions;
  const own = ownDomain(target);

  if (!fs.existsSync(csvPath)) throw new Error(`CSV が見つかりません: ${csvPath}`);
  const rows = parseManualCsv(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) throw new Error('CSV にデータ行がありません');

  const known = new Set(questions.map((q) => q.no));
  for (const r of rows) {
    if (!known.has(r.questionNo)) throw new Error(`${r.line} 行目: question_no ${r.questionNo} は config/questions/${slug}.json にありません`);
    if (isEngine(r.engine)) console.warn(`注意: ${r.line} 行目の engine "${r.engine}" は自動計測エンジンと同名です。自動計測の結果と合算されます`);
  }

  // (date, engine) ごとに既存の手動ファイルを置き換える
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.date}|${r.engine}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  let written = 0;
  for (const [key, list] of groups) {
    const [date, engine] = key.split('|') as [string, string];
    const dir = ensureDir(path.join(dateDir(slug, date), 'manual'));
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${engine}-q`) && f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
    const counter = new Map<number, number>();
    for (const r of list) {
      const runIndex = (counter.get(r.questionNo) ?? 0) + 1;
      counter.set(r.questionNo, runIndex);
      const ex = manualRowToExtraction(r, runIndex, target, own);
      writeJson(path.join(dir, `${ex.id}.json`), ex);
      written++;
    }
    console.log(`  ${date} ${engineLabel(engine)} (${engine}): ${list.length} 件 → ${rel(dir)}`);
  }
  console.log(`取り込み完了: ${written} 件。レポートに反映するには npm run report -- ${slug} --date <日付> を実行してください`);
}
