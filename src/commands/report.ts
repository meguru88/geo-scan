import fs from 'node:fs';
import path from 'node:path';
import { buildAggregate, loadExtractions, type Aggregate } from '../lib/aggregate.js';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { buildComparison } from '../lib/compare.js';
import { loadQuestions, loadTarget } from '../lib/config.js';
import { renderReport } from '../lib/html.js';
import { htmlToPdf } from '../lib/pdf.js';
import { assertDate, latestDate, rel, runDirFor, writeJson } from '../lib/runs.js';
import { getAdvice } from '../lib/suggest.js';
import type { Question, TargetConfig } from '../lib/types.js';

function aggregateFor(slug: string, date: string, run: number | undefined, target: TargetConfig, currentQuestions: Question[]): Aggregate {
  const runDir = runDirFor(slug, date, run);
  if (!runDir) throw new Error(`runs/${slug}/${date}${run ? `（--run ${run}）` : ''} がありません`);
  const { extractions, meta } = loadExtractions(slug, date, runDir);
  if (extractions.length === 0) {
    throw new Error(
      `${rel(runDir)} に抽出結果がありません。npm run scan -- ${slug} または npm run extract -- ${slug} --date ${date}、あるいは npm run import-manual を先に実行してください`,
    );
  }
  // 計測時点の質問文を優先する（後で質問を変えても、その日の結果は当時の質問で表示・比較する）
  const questions = meta?.questions?.length ? meta.questions : currentQuestions;
  return buildAggregate({ slug, date, runDir, target, questions, extractions, ...(meta ? { meta } : {}) });
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error('使い方: npm run report -- <slug> [--date YYYY-MM-DD] [--run N] [--compare YYYY-MM-DD] [--no-pdf]');
  const target = loadTarget(slug);
  const questions = loadQuestions(slug).questions;

  const date = flagString(args, 'date') ? assertDate(flagString(args, 'date')!) : latestDate(slug);
  if (!date) throw new Error(`runs/${slug} に計測結果がありません。先に npm run scan -- ${slug} を実行してください`);
  const runNo = flagString(args, 'run') ? flagNumber(args, 'run', 0) : undefined;
  const compareDate = flagString(args, 'compare') ? assertDate(flagString(args, 'compare')!) : null;
  if (compareDate === date) throw new Error('--compare には別の日付を指定してください');

  const agg = aggregateFor(slug, date, runNo, target, questions);
  writeJson(path.join(agg.runDir, 'aggregate.json'), agg);
  console.log(`集計: ${rel(agg.runDir)}  有効回答 ${agg.overall.answers} 件（失敗 ${agg.totals.errors}、費用上限で未実行 ${agg.totals.skipped}、手入力 ${agg.totals.manual}）`);
  console.log(`総合スコア ${agg.overall.total} / 100  ` + agg.byEngine.map((e) => `${e.label} ${e.total}`).join('  '));

  let comparison = null;
  if (compareDate) {
    const before = aggregateFor(slug, compareDate, undefined, target, questions);
    comparison = buildComparison(before, agg);
    console.log(
      `比較（${comparison.commonEngines.join(',')}）: ${compareDate} (${comparison.overall.before}) → ${date} (${comparison.overall.after})  差 ${comparison.overall.diff > 0 ? '+' : ''}${comparison.overall.diff}  新規 ${comparison.newlyMentioned.length} / 消失 ${comparison.lost.length}${comparison.onlyAfter.length ? `  今回から: ${comparison.onlyAfter.join(',')}` : ''}${comparison.changedQuestions.length ? `  質問文変更: Q${comparison.changedQuestions.map((c) => c.no).join(',')}` : ''}`,
    );
  }

  const advice = await getAdvice(agg, (l) => console.log(l));
  const html = renderReport(agg, advice, comparison);
  const htmlFile = path.join(agg.runDir, 'report.html');
  fs.writeFileSync(htmlFile, html);
  console.log(`HTML: ${rel(htmlFile)}`);

  const pdfFile = path.join(agg.runDir, 'report.pdf');
  if (flagBool(args, 'no-pdf')) {
    // 古い PDF が HTML と食い違ったまま残らないように消す
    if (fs.existsSync(pdfFile)) {
      fs.unlinkSync(pdfFile);
      console.log(`--no-pdf のため古い ${rel(pdfFile)} を削除しました`);
    }
    return;
  }
  const ok = await htmlToPdf(html, pdfFile);
  if (ok) console.log(`PDF:  ${rel(pdfFile)}`);
  else process.exitCode = 2;
}
