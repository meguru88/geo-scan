import path from 'node:path';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { extractModel } from '../lib/claude.js';
import { loadQuestions, loadTarget } from '../lib/config.js';
import { apiKey, hasAnthropicKey, isMock, KEY_ENV, usdJpyRate } from '../lib/env.js';
import { extractRun, shouldUseClaude } from '../lib/extract.js';
import { mapPool, withRetry } from '../lib/pool.js';
import { costUsd, estimateCallUsd, estimateScanCost, modelFor, pricingFor, toJpy, yen } from '../lib/pricing.js';
import { confirm } from '../lib/prompt.js';
import { errorMessage, redact, redactDeep } from '../lib/redact.js';
import { assertDate, ensureDir, newRunDir, rel, todayLocal, writeJson } from '../lib/runs.js';
import { engineLabel, parseEngines, type Engine, type Question, type RawAnswer } from '../lib/types.js';
import { createProvider } from '../providers/index.js';
import { describeLocation, searchLocationFor, type SearchLocation } from '../providers/location.js';
import type { Provider } from '../providers/types.js';

const RETRIES = 2;
const RETRY_BASE_MS = 1500;
/** 仕様: 並列は各エンジン 2 まで */
const MAX_CONCURRENCY = 2;

interface Task {
  engine: Engine;
  question: Question;
  runIndex: number;
}

/** scan の結果（add / batch が費用とディレクトリを受け取る） */
export interface ScanResult {
  runDir: string;
  date: string;
  meta: ScanMeta;
}

/** runs/<slug>/<date>/meta.json */
export interface ScanMeta {
  slug: string;
  date: string;
  runDir: string;
  mock: boolean;
  startedAt: string;
  finishedAt?: string;
  runs: number;
  engines: Engine[];
  models: Record<string, string>;
  questionCount: number;
  /** 計測時点の質問（後で質問を変えても比較できるように保存） */
  questions?: Question[];
  searchLocation?: SearchLocation;
  estimate: { usd: number; jpy: number; maxCostJpy: number; usdJpy: number };
  actual?: { usd: number; jpy: number; ok: number; error: number; skipped: number; extractUsd?: number };
}

function id(engine: Engine, q: Question, r: number): string {
  return `${engine}-q${String(q.no).padStart(2, '0')}-r${r}`;
}

function errorRecord(base: Omit<RawAnswer, 'status' | 'error' | 'text' | 'citations' | 'usage' | 'costUsd' | 'costJpy'>, error: string): RawAnswer {
  return { ...base, status: 'error', error, text: '', citations: [], usage: { inputTokens: 0, outputTokens: 0, searches: 0 }, costUsd: 0, costJpy: 0 };
}

/** 実行したら結果を返す。確認で中止したときは null */
export async function run(argv: string[]): Promise<ScanResult | null> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error('使い方: npm run scan -- <slug> [--runs 3] [--engines a,b] [--max-cost 500] [--mock]');

  const runs = Math.max(1, Math.floor(flagNumber(args, 'runs', 3)));
  const engines = parseEngines(flagString(args, 'engines'));
  const maxCostJpy = flagNumber(args, 'max-cost', Number(process.env.GEO_SCAN_MAX_COST) || 500);
  const requestedConcurrency = Math.max(1, Math.floor(flagNumber(args, 'concurrency', MAX_CONCURRENCY)));
  if (requestedConcurrency > MAX_CONCURRENCY) console.warn(`注意: --concurrency は各エンジン ${MAX_CONCURRENCY} までです（${requestedConcurrency} → ${MAX_CONCURRENCY}）`);
  const concurrency = Math.min(MAX_CONCURRENCY, requestedConcurrency);
  const date = flagString(args, 'date') ? assertDate(flagString(args, 'date')!) : todayLocal();
  const seed = flagString(args, 'seed') ?? date;
  const mock = isMock();
  const skipExtract = flagBool(args, 'skip-extract');

  const target = loadTarget(slug);
  const questions = loadQuestions(slug).questions;
  const location = searchLocationFor(target);

  if (!mock) {
    const missing = engines.filter((e) => !apiKey(e)).map((e) => KEY_ENV[e]);
    if (missing.length) {
      throw new Error(`APIキーがありません: ${missing.join(', ')}。.env に設定するか --engines で除外してください`);
    }
    if (!hasAnthropicKey()) console.warn('注意: ANTHROPIC_API_KEY がないため抽出は regex のみになります（順位・理由の精度が落ちます）');
  }

  // --- 概算費用 ---
  const useClaude = shouldUseClaude();
  const estimate = estimateScanCost(engines, questions.length, runs, useClaude ? extractModel() : null);
  const models = estimate.models;
  const perCallUsd: Record<string, number> = {};
  for (const e of engines) perCallUsd[e] = estimateCallUsd(e, models[e]!);
  const estUsd = estimate.totalUsd;
  console.log(`\n■ 計測の概算費用（1ドル=${usdJpyRate()}円）${mock ? '  ※モック実行ですが概算は本番の料金で計算します' : ''}`);
  console.log('  エンジン       モデル                  回数   1回あたり     小計');
  for (const row of estimate.rows) {
    console.log(
      `  ${row.label.padEnd(12)} ${row.model.padEnd(22)} ${String(row.calls).padStart(4)}   ${yen(row.perCallUsd).padStart(8)}   ${yen(row.subtotalUsd).padStart(9)}`,
    );
  }
  console.log(`  合計見込み: ${yen(estUsd)}（上限 --max-cost ¥${maxCostJpy}）`);
  console.log(`  検索の地域設定: ${describeLocation(location)}${target.searchLocation ? '' : '（国のみ。市区町村は config の searchLocation で指定）'}`);
  console.log(`  ※ 検索結果がコンテキストに入るため実際のトークン数は前後します。実費は raw/*.json と meta.json に記録します。`);

  if (toJpy(estUsd) > maxCostJpy) {
    throw new Error(
      `見込み費用 ${yen(estUsd)} が上限 ¥${maxCostJpy} を超えるため中止しました。--max-cost を上げるか、--runs / --engines を減らしてください`,
    );
  }

  if (!mock && !flagBool(args, 'yes')) {
    const ok = await confirm('この内容で実行しますか？ [y/N] ');
    if (!ok) {
      console.log('中止しました');
      return null;
    }
  }

  // --- 実行準備 ---
  const runDir = newRunDir(slug, date);
  ensureDir(path.join(runDir, 'raw'));
  const meta: ScanMeta = {
    slug,
    date,
    runDir: rel(runDir),
    mock,
    startedAt: new Date().toISOString(),
    runs,
    engines,
    models,
    questionCount: questions.length,
    questions,
    searchLocation: location,
    estimate: { usd: estUsd, jpy: toJpy(estUsd), maxCostJpy, usdJpy: usdJpyRate() },
  };
  writeJson(path.join(runDir, 'meta.json'), meta);
  console.log(`\n■ 計測開始: ${rel(runDir)}  質問 ${questions.length} × エンジン ${engines.length} × ${runs} 回 = ${questions.length * engines.length * runs} 回${mock ? '（モック）' : ''}\n`);

  const providers = new Map<Engine, Provider>();
  for (const e of engines) providers.set(e, createProvider(e, target, { slug, date, seed }, mock));

  const totalCalls = questions.length * engines.length * runs;
  const capUsd = maxCostJpy / usdJpyRate();
  let done = 0;
  let okCount = 0;
  let errCount = 0;
  let skippedCount = 0;
  let actualUsd = 0;
  let inFlightUsd = 0;
  let capReached = false;

  const startedAll = Date.now();

  const runEngine = async (engine: Engine): Promise<void> => {
    const provider = providers.get(engine)!;
    const tasks: Task[] = [];
    for (let r = 1; r <= runs; r++) for (const q of questions) tasks.push({ engine, question: q, runIndex: r });
    const perCall = perCallUsd[engine] ?? 0;

    await mapPool(tasks, concurrency, async (task) => {
      const rawId = id(engine, task.question, task.runIndex);
      const startedAt = new Date();
      const base = {
        id: rawId,
        slug,
        date,
        engine,
        model: provider.model,
        questionNo: task.question.no,
        question: task.question.text,
        runIndex: task.runIndex,
        startedAt: startedAt.toISOString(),
        finishedAt: startedAt.toISOString(),
        durationMs: 0,
        attempts: 0,
      };
      let raw: RawAnswer;

      // 実費＋実行中の見込みが上限に達したら、以降は呼ばずに skipped として記録する
      if (!capReached && actualUsd + inFlightUsd + perCall > capUsd) {
        capReached = true;
        console.log(`\n!! 実費 ${yen(actualUsd)}（＋実行中 ${yen(inFlightUsd)}）が上限 ¥${maxCostJpy} に達するため、未実行分は skipped として記録します\n`);
      }
      if (capReached) {
        raw = errorRecord(base, `skipped: 費用上限 ¥${maxCostJpy} に達したため未実行`);
      } else {
        inFlightUsd += perCall;
        try {
          const { value, attempts } = await withRetry(
            () => provider.ask(task.question.text, { questionNo: task.question.no, runIndex: task.runIndex }),
            {
              retries: RETRIES,
              baseDelayMs: RETRY_BASE_MS,
              onRetry: (err, attempt) => console.log(`  [${engineLabel(engine)}] ${rawId} 失敗（${attempt}回目）: ${errorMessage(err).slice(0, 120)} → 再試行`),
            },
          );
          const finishedAt = new Date();
          const usd = value.costUsd ?? costUsd(engine, provider.model, value.usage);
          raw = {
            ...base,
            model: value.model,
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempts,
            status: 'ok',
            text: redact(value.text),
            citations: value.citations,
            usage: value.usage,
            costUsd: usd,
            costJpy: toJpy(usd),
            providerRaw: value.raw,
          };
        } catch (err) {
          const finishedAt = new Date();
          raw = errorRecord({ ...base, finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(), attempts: RETRIES + 1 }, errorMessage(err));
        } finally {
          inFlightUsd -= perCall;
        }
      }

      writeJson(path.join(runDir, 'raw', `${rawId}.json`), redactDeep(raw));
      done++;
      if (raw.status === 'ok') {
        okCount++;
        actualUsd += raw.costUsd;
      } else if (raw.error?.startsWith('skipped:')) {
        skippedCount++;
      } else {
        errCount++;
      }
      const status =
        raw.status === 'ok'
          ? `ok  ${(raw.durationMs / 1000).toFixed(1)}s ${yen(raw.costUsd)} 引用${raw.citations.length}`
          : raw.error?.startsWith('skipped:')
            ? 'SKIP 費用上限'
            : `ERR ${raw.error?.slice(0, 80)}`;
      console.log(`  [${engineLabel(engine).padEnd(10)}] ${rawId.padEnd(22)} ${status}   (${done}/${totalCalls})`);
    });
  };

  await Promise.all(engines.map((e) => runEngine(e)));

  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(0);
  meta.finishedAt = new Date().toISOString();
  meta.actual = { usd: actualUsd, jpy: toJpy(actualUsd), ok: okCount, error: errCount, skipped: skippedCount };
  writeJson(path.join(runDir, 'meta.json'), meta);
  console.log(`\n■ 計測完了: 成功 ${okCount} / 失敗 ${errCount} / 費用上限で未実行 ${skippedCount} / 実費 ${yen(actualUsd)} / ${elapsed}s`);
  for (const e of engines) {
    const p = pricingFor(e, models[e]!);
    if (p.note) console.log(`   ${engineLabel(e)}: ${models[e]}（${p.note}）`);
  }

  if (skipExtract) {
    console.log(`\n抽出は省略しました。後で \`npm run extract -- ${slug} --date ${date}\` を実行してください`);
    return { runDir, date, meta };
  }

  console.log(`\n■ 抽出（${useClaude ? `regex + Claude ${extractModel()}` : 'regex のみ'}）`);
  const ex = await extractRun(runDir, { target, useClaude, log: (l) => console.log(l) });
  meta.actual.extractUsd = ex.costUsd;
  writeJson(path.join(runDir, 'meta.json'), meta);
  console.log(`■ 抽出完了: ${ex.extracted} 件 / Claude ${ex.claudeCalls} 回 / 費用 ${yen(ex.costUsd)}`);
  console.log(`\n次: npm run report -- ${slug}${date === todayLocal() ? '' : ` --date ${date}`}`);
  return { runDir, date, meta };
}
