import fs from 'node:fs';
import path from 'node:path';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { canStartNext, exceededBudget, formatBatchSummary, parseBatchCsv, type BatchResult, type BatchRow } from '../lib/batch.js';
import { extractModel } from '../lib/claude.js';
import { ROOT } from '../lib/config.js';
import { defaultMaxCostJpy, hasAnthropicKey, isMock, usdJpyRate } from '../lib/env.js';
import { shouldUseClaude } from '../lib/extract.js';
import { estimateScanCost, toJpy, yen } from '../lib/pricing.js';
import { confirm } from '../lib/prompt.js';
import { errorMessage } from '../lib/redact.js';
import { latestDate, latestRunDir, rel } from '../lib/runs.js';
import { engineLabel, parseEngines } from '../lib/types.js';
import { addTarget } from './add.js';
import { QUESTION_COUNT } from './questions.js';
import type { ScanMeta } from './scan.js';

const USAGE =
  ' 使い方: npm run batch [-- [config/batch.csv] [--engines openai,gemini] [--runs 3] [--max-cost 1000] [--max-total-cost 3000] [--force] [--yes]]';
const DEFAULT_FILE = path.join('config', 'batch.csv');
const DEFAULT_MAX_TOTAL_JPY = 3000;

/** `--max-total-cost` の既定値（.env の GEO_SCAN_MAX_TOTAL_COST か 3000 円） */
function defaultMaxTotalJpy(): number {
  return Number(process.env.GEO_SCAN_MAX_TOTAL_COST) || DEFAULT_MAX_TOTAL_JPY;
}

/**
 * 途中で失敗した社でも scan まで進んでいれば費用が発生している。
 * この一括実行で始まった最新 run の meta.json から実費を拾う（なければ 0）
 */
function spentSince(slug: string, startedAtIso: string): number {
  try {
    const date = latestDate(slug);
    if (!date) return 0;
    const dir = latestRunDir(slug, date);
    if (!dir) return 0;
    const file = path.join(dir, 'meta.json');
    if (!fs.existsSync(file)) return 0;
    const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as ScanMeta;
    if (!meta.startedAt || meta.startedAt < startedAtIso) return 0;
    return toJpy((meta.actual?.usd ?? 0) + (meta.actual?.extractUsd ?? 0));
  } catch {
    return 0;
  }
}

function rowLabel(row: BatchRow): string {
  return [row.slug, row.name ?? '', row.url].filter(Boolean).join('  ');
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (flagBool(args, 'help')) {
    console.log(USAGE);
    return;
  }
  const file = path.resolve(ROOT, flagString(args, 'file') ?? args.positionals[0] ?? DEFAULT_FILE);
  const runs = Math.max(1, Math.floor(flagNumber(args, 'runs', 3)));
  const enginesArg = flagString(args, 'engines');
  const engines = parseEngines(enginesArg);
  const maxCostJpy = flagNumber(args, 'max-cost', defaultMaxCostJpy());
  const maxTotalJpy = flagNumber(args, 'max-total-cost', defaultMaxTotalJpy());
  if (!(maxTotalJpy > 0)) throw new Error(`--max-total-cost は 1 以上で指定してください（指定値: ${maxTotalJpy}）`);
  const force = flagBool(args, 'force');
  const yes = flagBool(args, 'yes');

  // API を呼ぶ前に、手元だけで分かることを先に弾く（全行を検証してから始める）
  if (isMock()) throw new Error('batch は add と同じく実際のサイトと Claude を使うため --mock では実行できません');
  if (!fs.existsSync(file)) {
    throw new Error(`${rel(file)} がありません。samples/batch.csv を参考に slug,url,name の CSV を置いてください。\n${USAGE}`);
  }
  const rows = parseBatchCsv(fs.readFileSync(file, 'utf8'));
  if (!hasAnthropicKey()) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません。サイトの解析と質問生成に必要です（.env を確認してください）');
  }

  // --- 計画と概算 ---
  const estimate = estimateScanCost(engines, QUESTION_COUNT, runs, shouldUseClaude() ? extractModel() : null);
  const perCompanyJpy = toJpy(estimate.totalUsd);
  const allJpy = perCompanyJpy * rows.length;
  console.log(`■ 一括診断: ${rel(file)} の ${rows.length} 社`);
  rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${rowLabel(r)}`));
  console.log(`\n■ 概算費用: 1 社あたり ${yen(estimate.totalUsd)} × ${rows.length} 社 = ¥${allJpy.toFixed(1)}（1ドル=${usdJpyRate()}円）`);
  console.log(`  ${engines.map((e) => engineLabel(e)).join('・')} に ${QUESTION_COUNT} 問 × ${runs} 回 = 1 社 ${QUESTION_COUNT * engines.length * runs} 回`);
  console.log(`  上限: 1 社 --max-cost ¥${maxCostJpy} / 全体 --max-total-cost ¥${maxTotalJpy}`);
  if (perCompanyJpy > maxCostJpy) {
    console.log(`  注意: 1 社の概算が --max-cost ¥${maxCostJpy} を超えるため、このままでは各社とも設定ファイルだけ作って計測に進みません。--max-cost を上げてください`);
  }
  if (allJpy > maxTotalJpy) {
    const fit = perCompanyJpy > 0 ? Math.floor(maxTotalJpy / perCompanyJpy) : rows.length;
    console.log(`  注意: 全社の概算が --max-total-cost ¥${maxTotalJpy} を超えます。累計が上限に達した時点で残りは未実行になります（概算では ${fit} 社まで）`);
  }
  console.log('  ※ 費用の集計は scan・抽出・掲載確認・改善提案の実費です。サイト解析・質問生成の Claude 呼び出しは含みません');

  if (!yes) {
    const ok = await confirm('\nこの内容で一括診断を始めますか？ [y/N] ');
    if (!ok) {
      console.log('中止しました');
      return;
    }
  }

  // --- 1 社ずつ順番に実行 ---
  const results: BatchResult[] = [];
  let totalJpy = 0;
  let stopped = false;
  const startedAll = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (stopped || !canStartNext(totalJpy, maxTotalJpy)) {
      results.push({ row, status: 'skipped', costJpy: 0, pdf: null, reason: `累計費用が上限 ¥${maxTotalJpy} に達したため未実行` });
      continue;
    }
    const bar = '='.repeat(64);
    console.log(`\n${bar}\n■ [${i + 1}/${rows.length}] ${rowLabel(row)}\n  累計費用 ¥${totalJpy.toFixed(1)} / 上限 ¥${maxTotalJpy}\n${bar}\n`);
    const startedAt = new Date().toISOString();
    try {
      const res = await addTarget({
        slug: row.slug,
        url: row.url,
        name: row.name,
        industry: row.industry,
        area: row.area,
        force,
        yes: true,
        runs,
        engines: enginesArg,
        maxCostJpy,
      });
      totalJpy += res.costJpy;
      if (!res.scanned) {
        results.push({ row, status: 'failed', costJpy: res.costJpy, pdf: null, reason: res.reason ?? '計測に進みませんでした' });
      } else if (!res.pdfFile) {
        results.push({ row, status: 'failed', costJpy: res.costJpy, pdf: null, reason: `PDF 化に失敗（${res.runDir}/report.html をブラウザで印刷してください）` });
      } else {
        results.push({ row, status: 'ok', costJpy: res.costJpy, pdf: res.pdfFile });
      }
    } catch (err) {
      const msg = errorMessage(err);
      const costJpy = spentSince(row.slug, startedAt);
      totalJpy += costJpy;
      console.error(`\n!! ${row.slug} は失敗しました: ${msg}`);
      console.error('   この社はスキップして次に進みます');
      results.push({ row, status: 'failed', costJpy, pdf: null, reason: msg.slice(0, 160) });
    }
    if (exceededBudget(totalJpy, maxTotalJpy)) {
      console.log(`\n!! 累計費用 ¥${totalJpy.toFixed(1)} が上限 --max-total-cost ¥${maxTotalJpy} を超えたため、ここで止めます`);
      stopped = true;
    }
  }

  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(0);
  console.log(`\n${formatBatchSummary(results, totalJpy, maxTotalJpy).join('\n')}`);
  console.log(`\n所要時間 ${elapsed}s`);
  if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
}
