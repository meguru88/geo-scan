import path from 'node:path';
import readline from 'node:readline/promises';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { loadQuestions, loadTarget } from '../lib/config.js';
import { apiKey, isMock, KEY_ENV, usdJpyRate } from '../lib/env.js';
import { mapPool, withRetry } from '../lib/pool.js';
import { costUsd, estimateCallUsd, modelFor, pricingFor, toJpy, yen } from '../lib/pricing.js';
import { errorMessage, redact } from '../lib/redact.js';
import { assertDate, ensureDir, newRunDir, rel, todayLocal, writeJson } from '../lib/runs.js';
import { ENGINES, engineLabel, isEngine, type Engine, type Question, type RawAnswer } from '../lib/types.js';
import { createProvider } from '../providers/index.js';
import type { Provider } from '../providers/types.js';

const RETRIES = 2;
const RETRY_BASE_MS = 1500;

interface Task {
  engine: Engine;
  question: Question;
  runIndex: number;
}

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
  estimate: { usd: number; jpy: number; maxCostJpy: number; usdJpy: number };
  actual?: { usd: number; jpy: number; ok: number; error: number };
}

function parseEngines(value: string | undefined): Engine[] {
  if (!value) return [...ENGINES];
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const out: Engine[] = [];
  for (const e of list) {
    if (!isEngine(e)) throw new Error(`不明なエンジン: ${e}（指定できるのは ${ENGINES.join(', ')}）`);
    if (!out.includes(e)) out.push(e);
  }
  if (out.length === 0) throw new Error('--engines が空です');
  return out;
}

function id(engine: Engine, q: Question, r: number): string {
  return `${engine}-q${String(q.no).padStart(2, '0')}-r${r}`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error('使い方: npm run scan -- <slug> [--runs 3] [--engines a,b] [--max-cost 500] [--mock]');

  const runs = Math.max(1, Math.floor(flagNumber(args, 'runs', 3)));
  const engines = parseEngines(flagString(args, 'engines'));
  const maxCostJpy = flagNumber(args, 'max-cost', Number(process.env.GEO_SCAN_MAX_COST) || 500);
  const concurrency = Math.max(1, Math.floor(flagNumber(args, 'concurrency', 2)));
  const date = flagString(args, 'date') ? assertDate(flagString(args, 'date')!) : todayLocal();
  const seed = flagString(args, 'seed') ?? date;
  const mock = isMock();

  const target = loadTarget(slug);
  const questions = loadQuestions(slug).questions;

  if (!mock) {
    const missing = engines.filter((e) => !apiKey(e)).map((e) => KEY_ENV[e]);
    if (missing.length) {
      throw new Error(`APIキーがありません: ${missing.join(', ')}。.env に設定するか --engines で除外してください`);
    }
  }

  // --- 概算費用 ---
  const models: Record<string, string> = {};
  const callsPerEngine = questions.length * runs;
  let estUsd = 0;
  console.log(`\n■ 計測の概算費用（1ドル=${usdJpyRate()}円）${mock ? '  ※モック実行ですが概算は本番の料金で計算します' : ''}`);
  console.log('  エンジン       モデル                  回数   1回あたり     小計');
  for (const e of engines) {
    const model = modelFor(e);
    models[e] = model;
    const per = estimateCallUsd(e, model);
    const sub = per * callsPerEngine;
    estUsd += sub;
    console.log(`  ${engineLabel(e).padEnd(12)} ${model.padEnd(22)} ${String(callsPerEngine).padStart(4)}   ${yen(per).padStart(8)}   ${yen(sub).padStart(9)}`);
  }
  console.log(`  合計見込み: ${yen(estUsd)}（上限 --max-cost ¥${maxCostJpy}）`);
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
      return;
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
    estimate: { usd: estUsd, jpy: toJpy(estUsd), maxCostJpy, usdJpy: usdJpyRate() },
  };
  writeJson(path.join(runDir, 'meta.json'), meta);
  console.log(`\n■ 計測開始: ${rel(runDir)}  質問 ${questions.length} × エンジン ${engines.length} × ${runs} 回 = ${questions.length * engines.length * runs} 回${mock ? '（モック）' : ''}\n`);

  const providers = new Map<Engine, Provider>();
  for (const e of engines) providers.set(e, createProvider(e, target, { slug, date, seed }, mock));

  const totalCalls = questions.length * engines.length * runs;
  let done = 0;
  let okCount = 0;
  let errCount = 0;
  let actualUsd = 0;
  const hardCapUsd = (maxCostJpy * 1.2) / usdJpyRate();
  let capReached = false;

  const startedAll = Date.now();

  const runEngine = async (engine: Engine): Promise<void> => {
    const provider = providers.get(engine)!;
    const tasks: Task[] = [];
    for (let r = 1; r <= runs; r++) for (const q of questions) tasks.push({ engine, question: q, runIndex: r });

    await mapPool(tasks, concurrency, async (task) => {
      const rawId = id(engine, task.question, task.runIndex);
      const startedAt = new Date();
      let raw: RawAnswer;

      if (capReached) {
        raw = {
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
          status: 'error',
          error: `skipped: 実費が上限（¥${maxCostJpy} の 120%）に達したため未実行`,
          text: '',
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, searches: 0 },
          costUsd: 0,
          costJpy: 0,
        };
      } else {
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
            id: rawId,
            slug,
            date,
            engine,
            model: value.model,
            questionNo: task.question.no,
            question: task.question.text,
            runIndex: task.runIndex,
            startedAt: startedAt.toISOString(),
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
          raw = {
            id: rawId,
            slug,
            date,
            engine,
            model: provider.model,
            questionNo: task.question.no,
            question: task.question.text,
            runIndex: task.runIndex,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempts: RETRIES + 1,
            status: 'error',
            error: errorMessage(err),
            text: '',
            citations: [],
            usage: { inputTokens: 0, outputTokens: 0, searches: 0 },
            costUsd: 0,
            costJpy: 0,
          };
        }
      }

      writeJson(path.join(runDir, 'raw', `${rawId}.json`), raw);
      done++;
      if (raw.status === 'ok') {
        okCount++;
        actualUsd += raw.costUsd;
        if (!capReached && actualUsd > hardCapUsd) {
          capReached = true;
          console.log(`\n!! 実費 ${yen(actualUsd)} が上限の 120% を超えたため、未実行分は error として記録します\n`);
        }
      } else {
        errCount++;
      }
      const status = raw.status === 'ok' ? `ok  ${(raw.durationMs / 1000).toFixed(1)}s ${yen(raw.costUsd)} 引用${raw.citations.length}` : `ERR ${raw.error?.slice(0, 80)}`;
      console.log(`  [${engineLabel(engine).padEnd(10)}] ${rawId.padEnd(22)} ${status}   (${done}/${totalCalls})`);
    });
  };

  await Promise.all(engines.map((e) => runEngine(e)));

  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(0);
  meta.finishedAt = new Date().toISOString();
  meta.actual = { usd: actualUsd, jpy: toJpy(actualUsd), ok: okCount, error: errCount };
  writeJson(path.join(runDir, 'meta.json'), meta);
  console.log(`\n■ 計測完了: 成功 ${okCount} / 失敗 ${errCount} / 実費 ${yen(actualUsd)} / ${elapsed}s`);
  for (const e of engines) {
    const p = pricingFor(e, models[e]!);
    if (p.note) console.log(`   ${engineLabel(e)}: ${models[e]}（${p.note}）`);
  }

  console.log(`\n次: npm run report -- ${slug}${date === todayLocal() ? '' : ` --date ${date}`}`);
}
