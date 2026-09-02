import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { loadTarget } from '../lib/config.js';
import { extractRun, shouldUseClaude } from '../lib/extract.js';
import { yen } from '../lib/pricing.js';
import { assertDate, latestDate, rel, runDirFor } from '../lib/runs.js';

/** raw/*.json から抽出だけをやり直す（scan の後処理と同じ） */
export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error('使い方: npm run extract -- <slug> [--date YYYY-MM-DD] [--run N] [--force]');
  const target = loadTarget(slug);
  const date = flagString(args, 'date') ? assertDate(flagString(args, 'date')!) : latestDate(slug);
  if (!date) throw new Error(`runs/${slug} に計測結果がありません`);
  const runNo = flagString(args, 'run') ? flagNumber(args, 'run', 0) : undefined;
  const runDir = runDirFor(slug, date, runNo);
  if (!runDir) throw new Error(`runs/${slug}/${date}${runNo ? `（--run ${runNo}）` : ''} がありません`);

  const useClaude = shouldUseClaude();
  console.log(`抽出: ${rel(runDir)} （${useClaude ? 'regex + Claude' : 'regex のみ'}）`);
  const summary = await extractRun(runDir, { target, useClaude, force: flagBool(args, 'force'), log: (l) => console.log(l) });
  console.log(
    `完了: ${summary.extracted} 件抽出 / ${summary.skipped} 件スキップ（既存） / Claude ${summary.claudeCalls} 回（失敗して regex に戻したもの ${summary.claudeFallbacks}）/ 費用 ${yen(summary.costUsd)}`,
  );
}
