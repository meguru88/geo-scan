import fs from 'node:fs';
import { flagBool, flagNumber, flagString, parseArgs } from '../lib/args.js';
import { extractModel, writerModel } from '../lib/claude.js';
import { assertSlug, questionsPath, saveQuestions, saveTarget, targetPath } from '../lib/config.js';
import { hasAnthropicKey, isMock, usdJpyRate } from '../lib/env.js';
import { shouldUseClaude } from '../lib/extract.js';
import { estimateScanCost, toJpy, yen } from '../lib/pricing.js';
import { findCompetitors, inferProfile, type ProfileOverrides, type SiteProfile } from '../lib/profile.js';
import { confirm } from '../lib/prompt.js';
import { rel } from '../lib/runs.js';
import { fetchSite } from '../lib/site.js';
import { engineLabel, parseEngines, type QuestionSet, type TargetConfig } from '../lib/types.js';
import { generateQuestions } from './questions.js';

const USAGE = ' 使い方: npm run add -- --slug <slug> --url <URL> [--name "会社名"] [--engines openai,gemini] [--force] [--yes]';

/** 保存した設定と質問を画面に出す */
function printSummary(target: TargetConfig, qs: QuestionSet, profile: SiteProfile, competitorSources: string[]): void {
  console.log('\n■ 診断対象');
  console.log(`  slug      : ${target.slug}`);
  console.log(`  会社名    : ${target.name}`);
  console.log(`  URL       : ${target.url}`);
  console.log(`  業種      : ${target.industry}`);
  console.log(`  地域      : ${target.area}（${target.areaAliases.join('・') || '別表記なし'}）`);
  console.log(`  社名の表記ゆれ: ${target.aliases.join('・')}`);
  console.log(`  推定の確度: ${profile.confidence}${profile.notes ? ` — ${profile.notes}` : ''}`);
  console.log(`\n■ 競合 ${target.competitors.length} 社`);
  console.log(`  ${target.competitors.join('・')}`);
  if (competitorSources.length) console.log(`  （参照: ${competitorSources.slice(0, 5).join('、')}）`);
  console.log(`\n■ 質問 ${qs.questions.length} 問（地域名入り ${qs.questions.filter((q) => q.withArea).length} 問）`);
  for (const q of qs.questions) console.log(`  ${String(q.no).padStart(2)}. ${q.text}${q.withArea ? '' : '　(地域名なし)'}`);
}

/** `--max-cost` の既定値（.env の GEO_SCAN_MAX_COST か 500 円） */
export function defaultMaxCostJpy(): number {
  return Number(process.env.GEO_SCAN_MAX_COST) || 500;
}

export interface AddOptions {
  slug: string;
  url: string;
  name?: string | undefined;
  industry?: string | undefined;
  area?: string | undefined;
  /** 既存の設定・質問を上書きする */
  force?: boolean;
  /** 計測前の確認を省略する */
  yes?: boolean;
  runs?: number;
  /** `--engines` の生の値（未指定なら全エンジン） */
  engines?: string | undefined;
  maxCostJpy?: number;
}

/** add の結果（batch が費用と PDF のパスを受け取るため） */
export interface AddResult {
  slug: string;
  /** scan → report まで実行したか（費用上限や確認で止めた場合は false） */
  scanned: boolean;
  /** scan と抽出の実費（円）。計測していなければ 0 */
  costJpy: number;
  /** レポートを出した run ディレクトリ（ROOT からの相対） */
  runDir: string | null;
  /** 生成した report.pdf（ROOT からの相対）。PDF 化に失敗したら null */
  pdfFile: string | null;
  /** 計測に進まなかった理由 */
  reason?: string;
}

/** サイトを読んで設定と質問を作り、続けて scan → report まで実行する（`run` と batch の共通部分） */
export async function addTarget(opts: AddOptions): Promise<AddResult> {
  const { slug, url } = opts;
  assertSlug(slug);
  const force = opts.force ?? false;
  const yes = opts.yes ?? false;
  const overrides: ProfileOverrides = { name: opts.name, industry: opts.industry, area: opts.area };

  // API を呼ぶ前に、手元だけで分かることを先に弾く
  if (isMock()) throw new Error('add は実際のサイトと Claude を使うため --mock では実行できません');
  const tFile = targetPath(slug);
  const qFile = questionsPath(slug);
  const existing = [tFile, qFile].filter((f) => fs.existsSync(f));
  if (existing.length && !force) {
    throw new Error(`${existing.map(rel).join(' と ')} が既にあります。上書きするには --force を付けてください`);
  }
  if (!hasAnthropicKey()) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません。サイトの解析と質問生成に必要です（.env を確認してください）');
  }

  // 1. サイトを取得
  console.log(`■ サイトを取得しています: ${url}`);
  const site = await fetchSite(url);
  console.log(`  ${site.status} ${site.finalUrl}（${site.charset} / 本文 ${site.text.length} 文字）`);
  console.log(`  タイトル: ${site.title || '(なし)'}`);

  // 2. 社名・業種・地域を推定
  console.log(`\n■ サイトの内容から会社情報を推定しています（${writerModel()}）…`);
  const { profile } = await inferProfile(site, overrides);
  console.log(`  ${profile.name} / ${profile.industry} / ${profile.area}`);

  // 3. 競合を Web 検索で調べる
  console.log(`\n■ 競合を Web 検索で調べています（${writerModel()}）…`);
  const { competitors, sources } = await findCompetitors(profile);
  console.log(`  ${competitors.length} 社: ${competitors.join('・')}`);

  // 4. 設定を書き出す（loadTarget と同じ検証を通すため saveTarget の後に読み直す）
  const target: TargetConfig = {
    slug,
    name: profile.name,
    aliases: profile.aliases,
    url: site.finalUrl,
    industry: profile.industry,
    area: profile.area,
    areaAliases: profile.areaAliases,
    competitors,
  };
  saveTarget(target);
  console.log(`\n保存しました: ${rel(tFile)}`);

  // 5. 質問を生成
  console.log(`\n■ 質問を 10 問生成しています（${writerModel()}）…`);
  const generated = await generateQuestions(target);
  const qs: QuestionSet = {
    slug,
    generatedAt: new Date().toISOString(),
    source: 'claude',
    model: generated.model,
    questions: generated.questions,
  };
  saveQuestions(qs);
  console.log(`保存しました: ${rel(qFile)}`);

  printSummary(target, qs, profile, sources);

  // 6. 続けて計測するか確認
  const runs = Math.max(1, Math.floor(opts.runs ?? 3));
  const engines = parseEngines(opts.engines);
  const engineArg = opts.engines ? ` --engines ${engines.join(',')}` : '';
  const maxCostJpy = opts.maxCostJpy ?? defaultMaxCostJpy();
  const estimate = estimateScanCost(engines, qs.questions.length, runs, shouldUseClaude() ? extractModel() : null);
  const estJpy = toJpy(estimate.totalUsd);

  console.log(`\n■ 計測（scan → report）の概算費用: ${yen(estimate.totalUsd)}（1ドル=${usdJpyRate()}円 / 上限 --max-cost ¥${maxCostJpy}）`);
  console.log(`  ${engines.map((e) => engineLabel(e)).join('・')} に ${qs.questions.length} 問 × ${runs} 回 = ${qs.questions.length * engines.length * runs} 回`);

  const notScanned = (reason: string): AddResult => ({ slug, scanned: false, costJpy: 0, runDir: null, pdfFile: null, reason });

  if (estJpy > maxCostJpy) {
    const suggested = Math.ceil(estJpy / 100) * 100;
    console.log(`\n見込み費用が上限 ¥${maxCostJpy} を超えるため、計測には進みません。設定ファイルは作成済みです。`);
    console.log(`  実行するには: npm run scan -- ${slug} --runs ${runs} --max-cost ${suggested}${engineArg}`);
    console.log(`  そのあと    : npm run report -- ${slug}`);
    return notScanned(`見込み費用 ${yen(estimate.totalUsd)} が --max-cost ¥${maxCostJpy} を超えるため計測せず（設定は作成済み）`);
  }

  if (!yes) {
    const ok = await confirm('\nこのまま計測しますか？ [y/N] ');
    if (!ok) {
      console.log('計測は行いませんでした。設定ファイルは作成済みです。');
      console.log(`  あとで実行するには: npm run scan -- ${slug} --runs ${runs} --max-cost ${maxCostJpy}${engineArg}`);
      return notScanned('確認で計測を見送り（設定は作成済み）');
    }
  }

  // 7. scan → report（費用を見積もったのと同じエンジンで測る）
  const scanArgs = [slug, '--runs', String(runs), '--max-cost', String(maxCostJpy), '--engines', engines.join(','), '--yes'];
  const scan = await (await import('./scan.js')).run(scanArgs);
  if (!scan) return notScanned('計測を中止しました');
  const actual = scan.meta.actual;
  const costJpy = toJpy((actual?.usd ?? 0) + (actual?.extractUsd ?? 0));
  const report = await (await import('./report.js')).run([slug, '--date', scan.date]);
  return {
    slug,
    scanned: true,
    costJpy,
    runDir: rel(report.runDir),
    pdfFile: report.pdfFile ? rel(report.pdfFile) : null,
  };
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const slug = flagString(args, 'slug') ?? args.positionals[0];
  const url = flagString(args, 'url') ?? args.positionals[1];
  if (!slug || !url) throw new Error(`--slug と --url は必須です。\n${USAGE}`);

  await addTarget({
    slug,
    url,
    name: flagString(args, 'name'),
    industry: flagString(args, 'industry'),
    area: flagString(args, 'area'),
    force: flagBool(args, 'force'),
    yes: flagBool(args, 'yes'),
    runs: flagNumber(args, 'runs', 3),
    engines: flagString(args, 'engines'),
    maxCostJpy: flagNumber(args, 'max-cost', defaultMaxCostJpy()),
  });
}
