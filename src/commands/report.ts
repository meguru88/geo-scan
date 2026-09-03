import fs from 'node:fs';
import path from 'node:path';
import { buildAggregate, loadExtractions, type Aggregate } from '../lib/aggregate.js';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { writerModel } from '../lib/claude.js';
import { buildComparison } from '../lib/compare.js';
import { loadQuestions, loadTarget } from '../lib/config.js';
import { defaultMaxCostJpy, hasAnthropicKey, isMock, usdJpyRate } from '../lib/env.js';
import { renderReport } from '../lib/html.js';
import {
  checkListings,
  describeListings,
  estimateListingUsd,
  listingSitesFor,
  listingsPath,
  loadListings,
  mockListings,
  saveListings,
  type ListingCheck,
} from '../lib/listings.js';
import { htmlToPdf } from '../lib/pdf.js';
import { estimateAdviceUsd, toJpy, yen } from '../lib/pricing.js';
import { errorMessage } from '../lib/redact.js';
import { assertDate, latestDate, rel, runDirFor, writeJson } from '../lib/runs.js';
import { getAdvice } from '../lib/suggest.js';
import type { Question, TargetConfig } from '../lib/types.js';

const USAGE = '使い方: npm run report -- <slug> [--date YYYY-MM-DD] [--run N] [--compare YYYY-MM-DD] [--max-cost 500] [--no-listings] [--recheck-listings] [--overwrite] [--no-pdf]';
const MAX_REPORT_INDEX = 999;

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

/**
 * 出力先。既に report.html / report.pdf があれば消さずに report-2.html / report-2.pdf のように番号を振る
 * （配布済みの PDF を再生成で上書きしないため）。--overwrite のときは report.html / report.pdf に固定
 */
export function reportPaths(runDir: string, overwrite = false): { htmlFile: string; pdfFile: string; index: number } {
  for (let index = 1; index <= MAX_REPORT_INDEX; index++) {
    const base = index === 1 ? 'report' : `report-${index}`;
    const htmlFile = path.join(runDir, `${base}.html`);
    const pdfFile = path.join(runDir, `${base}.pdf`);
    if (overwrite || (!fs.existsSync(htmlFile) && !fs.existsSync(pdfFile))) return { htmlFile, pdfFile, index };
  }
  throw new Error(`${rel(runDir)} にレポートが多すぎます（report-${MAX_REPORT_INDEX} まで）。古いものを整理してください`);
}

/** report の結果（add / batch が PDF のパスと費用を受け取る） */
export interface ReportResult {
  runDir: string;
  htmlFile: string;
  /** PDF 化に失敗した・--no-pdf のときは null */
  pdfFile: string | null;
  /** 掲載確認と改善提案で Claude を呼んだ実費（USD） */
  costUsd: number;
}

/**
 * 掲載確認。同じ run に結果があれば再利用し、無ければ費用上限の範囲で Web 検索する。
 * 戻り値の costUsd は今回新たに使った分
 */
async function resolveListings(
  agg: Aggregate,
  opts: { skip: boolean; recheck: boolean; spentUsd: number; budgetUsd: number; maxCostJpy: number },
): Promise<{ listings: ListingCheck | null; costUsd: number }> {
  const none = { listings: null, costUsd: 0 };
  if (opts.skip) {
    console.log('掲載確認: --no-listings のため省略します');
    return none;
  }
  const cached = loadListings(agg.runDir);
  if (cached && !opts.recheck) {
    console.log(`掲載確認: 前回の結果を使います（${rel(listingsPath(agg.runDir))}。やり直すには --recheck-listings）`);
    return { listings: cached, costUsd: 0 };
  }
  if (isMock()) {
    const listings = mockListings(agg.target);
    saveListings(agg.runDir, listings);
    console.log('掲載確認: モック（先頭 2 サイトを掲載あり、3 つ目を掲載なしとして扱います）');
    return { listings, costUsd: 0 };
  }
  if (!hasAnthropicKey()) {
    console.log('掲載確認: ANTHROPIC_API_KEY がないため省略します（提案では掲載の有無を「未確認」として扱います）');
    return none;
  }
  const sites = listingSitesFor(agg.target);
  const estimateUsd = estimateListingUsd(agg.target);
  if (opts.spentUsd + estimateUsd > opts.budgetUsd) {
    const needed = Math.ceil(toJpy(opts.spentUsd + estimateUsd) / 100) * 100;
    console.log(
      `掲載確認: 見込み ${yen(estimateUsd)} を足すと上限 --max-cost ¥${opts.maxCostJpy} を超えるため省略します（計測と抽出の実費 ${yen(opts.spentUsd)}）。` +
        `実行するには npm run report -- ${agg.slug} --date ${agg.date} --max-cost ${needed}`,
    );
    return none;
  }
  console.log(`掲載確認: ${sites.join(' / ')} を Web 検索で確認中（${writerModel()} / 見込み ${yen(estimateUsd)}）…`);
  try {
    const listings = await checkListings(agg.target, sites);
    saveListings(agg.runDir, listings);
    console.log(`  実費 ${yen(listings.costUsd)}（検索 ${listings.searches} 回）→ ${rel(listingsPath(agg.runDir))}`);
    return { listings, costUsd: listings.costUsd };
  } catch (err) {
    console.log(`掲載確認: 失敗したため省略します（${errorMessage(err).slice(0, 160)}）`);
    return none;
  }
}

export async function run(argv: string[]): Promise<ReportResult> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error(USAGE);
  const target = loadTarget(slug);
  const questions = loadQuestions(slug).questions;

  const date = flagString(args, 'date') ? assertDate(flagString(args, 'date')!) : latestDate(slug);
  if (!date) throw new Error(`runs/${slug} に計測結果がありません。先に npm run scan -- ${slug} を実行してください`);
  const runNo = flagString(args, 'run') ? flagNumber(args, 'run', 0) : undefined;
  const compareDate = flagString(args, 'compare') ? assertDate(flagString(args, 'compare')!) : null;
  if (compareDate === date) throw new Error('--compare には別の日付を指定してください');
  const maxCostJpy = flagNumber(args, 'max-cost', defaultMaxCostJpy());

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

  // --- 費用上限: scan と抽出の実費に、掲載確認と改善提案の見込みを足して --max-cost に収める ---
  const budgetUsd = maxCostJpy / usdJpyRate();
  let spentUsd = (agg.meta?.actual?.usd ?? 0) + (agg.meta?.actual?.extractUsd ?? 0);
  let costUsd = 0;

  const found = await resolveListings(agg, {
    skip: flagBool(args, 'no-listings'),
    recheck: flagBool(args, 'recheck-listings'),
    spentUsd,
    budgetUsd,
    maxCostJpy,
  });
  const listings = found.listings;
  spentUsd += found.costUsd;
  costUsd += found.costUsd;
  if (listings) for (const line of describeListings(listings)) console.log(`  ${line}`);

  let allowClaude = true;
  if (!isMock() && hasAnthropicKey()) {
    const adviceUsd = estimateAdviceUsd(writerModel());
    if (spentUsd + adviceUsd > budgetUsd) {
      allowClaude = false;
      console.log(`改善提案: 見込み ${yen(adviceUsd)} を足すと上限 --max-cost ¥${maxCostJpy} を超えるため、Claude を呼ばずテンプレートを使います`);
    }
  }
  const advice = await getAdvice(agg, { listings, allowClaude, log: (l) => console.log(l) });
  costUsd += advice.costUsd;
  if (costUsd > 0) console.log(`レポート生成の実費 ${yen(costUsd)}（計測と合わせて ${yen(spentUsd + advice.costUsd)} / 上限 ¥${maxCostJpy}）`);

  const html = renderReport(agg, advice, comparison);
  const overwrite = flagBool(args, 'overwrite');
  const { htmlFile, pdfFile, index } = reportPaths(agg.runDir, overwrite);
  fs.writeFileSync(htmlFile, html);
  if (index > 1) console.log(`既存の report.html / report.pdf は残し、${path.basename(htmlFile)} に出力します（上書きするには --overwrite）`);
  console.log(`HTML: ${rel(htmlFile)}`);

  if (flagBool(args, 'no-pdf')) {
    // 上書きモードでは、古い PDF が HTML と食い違ったまま残らないように消す
    if (overwrite && fs.existsSync(pdfFile)) {
      fs.unlinkSync(pdfFile);
      console.log(`--no-pdf のため古い ${rel(pdfFile)} を削除しました`);
    }
    return { runDir: agg.runDir, htmlFile, pdfFile: null, costUsd };
  }
  const ok = await htmlToPdf(html, pdfFile);
  if (ok) console.log(`PDF:  ${rel(pdfFile)}`);
  else process.exitCode = 2;
  return { runDir: agg.runDir, htmlFile, pdfFile: ok ? pdfFile : null, costUsd };
}
