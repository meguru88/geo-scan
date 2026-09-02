import fs from 'node:fs';
import path from 'node:path';
import { askJson, extractModel } from './claude.js';
import { ownDomain } from './config.js';
import { hasAnthropicKey, isMock } from './env.js';
import { mapPool, withRetry } from './pool.js';
import { estimateExtractUsd } from './pricing.js';
import { errorMessage } from './redact.js';
import { readJsonFiles, writeJson } from './runs.js';
import type { BusinessMention, Extraction, RawAnswer, TargetConfig } from './types.js';

/**
 * 全角/半角・大文字小文字・空白の揺れを吸収した比較用文字列と、
 * 正規化後の各文字が元テキストの何文字目に由来するかの対応表。
 * （㈱ → (株) のように NFKC で長さが変わる文字があるので、文字ごとに正規化して対応を取る）
 */
export function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    for (const ch of s[i]!.normalize('NFKC').toLowerCase()) {
      if (/\s/.test(ch)) continue;
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

export function normalize(s: string): string {
  return normalizeWithMap(s).norm;
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/^[\s#>*・\-–—]+/, '')
    .replace(/^\d+[.．)）]\s*/, '')
    .trim();
}

const SENTENCE_END = new Set(['。', '\n', '！', '？']);

/** 文字位置 index を含む文（。または改行区切り）とその終端位置を返す */
function sentenceAt(text: string, index: number): { text: string; end: number } {
  let start = 0;
  for (let i = index; i >= 0; i--) {
    if (SENTENCE_END.has(text[i]!)) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = Math.max(index, start); i < text.length; i++) {
    if (SENTENCE_END.has(text[i]!)) {
      end = i + (text[i] === '\n' ? 0 : 1);
      break;
    }
  }
  return { text: stripMarkdown(text.slice(start, end)), end };
}

/**
 * 業者名が出た文を「理由」として返す。見出し行のように名前だけの文なら、続く文を使う
 * （例: "1. **おたからや**\n全国に店舗があり…" → "全国に店舗があり…"）
 */
function reasonAt(text: string, index: number, name: string): string {
  const first = sentenceAt(text, index);
  const bare = normalize(first.text).replace(/[：:・、,\-—–|（）()「」]/g, '');
  if (bare.length > normalize(name).length + 4) return first.text;
  let next = first.end + 1;
  while (next < text.length && /\s/.test(text[next]!)) next++;
  if (next >= text.length) return first.text;
  const second = sentenceAt(text, next);
  return second.text || first.text;
}

/** 名前の最初の出現位置（正規化後）。見つからなければ -1 */
function indexOfName(normText: string, name: string): number {
  const n = normalize(name);
  if (!n) return -1;
  return normText.indexOf(n);
}

export interface RegexResult {
  mentioned: boolean;
  citedOwnSite: boolean;
  citedDomains: string[];
  businesses: BusinessMention[];
  competitorsMentioned: string[];
}

/** 正規表現（文字列一致）だけで取れる分 */
export function regexExtract(raw: Pick<RawAnswer, 'text' | 'citations'>, target: TargetConfig): RegexResult {
  const { norm: normText, map } = normalizeWithMap(raw.text);
  const toOriginal = (normIndex: number): number => map[normIndex] ?? Math.max(0, raw.text.length - 1);
  const own = ownDomain(target);

  const found: { name: string; isTarget: boolean; index: number }[] = [];
  let targetIndex = -1;
  for (const alias of target.aliases) {
    const i = indexOfName(normText, alias);
    if (i >= 0 && (targetIndex < 0 || i < targetIndex)) targetIndex = i;
  }
  if (targetIndex >= 0) found.push({ name: target.name, isTarget: true, index: targetIndex });
  for (const c of target.competitors) {
    const i = indexOfName(normText, c);
    if (i >= 0) found.push({ name: c, isTarget: false, index: i });
  }
  found.sort((a, b) => a.index - b.index);

  const businesses: BusinessMention[] = found.map((f) => ({
    name: f.name,
    isTarget: f.isTarget,
    reason: reasonAt(raw.text, toOriginal(f.index), f.name).slice(0, 120),
  }));

  const citedDomains = [...new Set(raw.citations.map((c) => c.domain))];
  const citedOwnSite = citedDomains.some((d) => d === own || d.endsWith(`.${own}`));

  return {
    mentioned: targetIndex >= 0,
    citedOwnSite,
    citedDomains,
    businesses,
    competitorsMentioned: found.filter((f) => !f.isTarget).map((f) => f.name),
  };
}

const CLAUDE_SCHEMA = {
  type: 'object',
  properties: {
    businesses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          isTarget: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['name', 'isTarget', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['businesses'],
  additionalProperties: false,
};

interface ClaudeExtraction {
  businesses: { name: string; isTarget: boolean; reason: string }[];
}

/** Claude（Haiku）で業者名を出現順に抽出し、選ばれた理由を1行ずつ取る */
export async function claudeExtract(
  raw: Pick<RawAnswer, 'text'>,
  target: TargetConfig,
): Promise<{ businesses: BusinessMention[]; model: string; usage: { inputTokens: number; outputTokens: number } }> {
  const system =
    'あなたは日本語の回答文から業者名（固有名詞）を抽出するアシスタントです。' +
    '回答文に書かれていることだけを使い、推測で補いません。JSON のみを返します。';
  const user = [
    `対象企業: ${target.name}（表記ゆれ: ${target.aliases.join(' / ')}）`,
    `既知の競合: ${target.competitors.join(' / ')}`,
    '',
    '次の回答文に登場する買取・整理・片付けなどの「業者名」を、出現順にすべて列挙してください。',
    '- 一般名詞（大手、リサイクルショップ、質屋 など）や地名、比較サイト名は含めない',
    '- 既知の競合の表記ゆれ（カタカナ/英字/略称）は既知の名前に正規化する',
    '- 対象企業（表記ゆれ含む）が出てきたら isTarget を true にする',
    '- reason には、回答文がその業者を勧めている理由・特徴を回答文の言葉で 1 行（40 文字以内）。書かれていなければ空文字',
    '',
    '回答文:',
    '"""',
    raw.text.slice(0, 12000),
    '"""',
    '',
    '出力形式: {"businesses":[{"name":"...","isTarget":false,"reason":"..."}]}',
  ].join('\n');

  const model = extractModel();
  const res = await askJson<ClaudeExtraction>({ model, system, user, schema: CLAUDE_SCHEMA, maxTokens: 2048 });
  const list = Array.isArray(res.value.businesses) ? res.value.businesses : [];
  const businesses: BusinessMention[] = [];
  const seen = new Set<string>();
  for (const b of list) {
    if (!b || typeof b.name !== 'string' || !b.name.trim()) continue;
    const key = normalize(b.name);
    if (seen.has(key)) continue;
    seen.add(key);
    businesses.push({ name: b.name.trim(), isTarget: Boolean(b.isTarget), reason: String(b.reason ?? '').trim().slice(0, 120) });
  }
  return { businesses, model: res.model, usage: res.usage };
}

export interface ExtractOptions {
  target: TargetConfig;
  useClaude: boolean;
  /** Claude 呼び出しの同時実行数 */
  concurrency?: number;
  force?: boolean;
  log?: (line: string) => void;
}

export interface ExtractSummary {
  total: number;
  extracted: number;
  skipped: number;
  claudeCalls: number;
  claudeFallbacks: number;
  costUsd: number;
}

/**
 * 名前の照合。完全一致か、一方が他方を含む（例: "買取大吉 難波店" ⊃ "買取大吉"）。
 * 「大吉」「買取」のような短い断片での誤結合を避けるため、短い側は 3 文字以上を要求する
 */
export function namesMatch(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short);
}

function canonicalCompetitor(name: string, target: TargetConfig): string | null {
  for (const c of target.competitors) if (namesMatch(name, c)) return c;
  return null;
}

function isTargetName(name: string, target: TargetConfig): boolean {
  return target.aliases.some((a) => namesMatch(name, a));
}

/** 1回答分の抽出。regex を土台に Claude の結果で業者リスト・順位・理由を補う */
export async function extractOne(raw: RawAnswer, opts: ExtractOptions): Promise<{ extraction: Extraction; claudeUsed: boolean; costUsd: number }> {
  const base: Omit<Extraction, 'mentioned' | 'rank' | 'citedOwnSite' | 'competitorsMentioned' | 'businesses' | 'citedDomains' | 'method'> = {
    id: raw.id,
    engine: raw.engine,
    questionNo: raw.questionNo,
    runIndex: raw.runIndex,
    status: raw.status,
    source: 'scan',
    extractedAt: new Date().toISOString(),
  };

  if (raw.status !== 'ok' || !raw.text.trim()) {
    return {
      extraction: { ...base, mentioned: false, rank: null, citedOwnSite: false, competitorsMentioned: [], businesses: [], citedDomains: [], method: 'regex', notes: raw.error ?? 'empty answer' },
      claudeUsed: false,
      costUsd: 0,
    };
  }

  const rx = regexExtract(raw, opts.target);
  let businesses = rx.businesses;
  let method: Extraction['method'] = 'regex';
  let model: string | undefined;
  let notes: string | undefined;
  let costUsd = 0;
  let claudeUsed = false;

  if (opts.useClaude) {
    try {
      const { value } = await withRetry(() => claudeExtract(raw, opts.target), { retries: 2, baseDelayMs: 1000 });
      claudeUsed = true;
      model = value.model;
      method = 'regex+claude';
      costUsd = estimateExtractUsdFromUsage(value.model, value.usage.inputTokens, value.usage.outputTokens);
      const normalized: BusinessMention[] = value.businesses.map((b) => {
        const isTarget = b.isTarget || isTargetName(b.name, opts.target);
        const canon = isTarget ? opts.target.name : (canonicalCompetitor(b.name, opts.target) ?? b.name);
        return { name: canon, isTarget, reason: b.reason };
      });
      // regex で見つかったのに Claude が落とした業者は末尾に補う
      for (const r of rx.businesses) {
        if (!normalized.some((b) => normalize(b.name) === normalize(r.name))) normalized.push(r);
      }
      // Claude が理由を空にした業者には regex の文を入れる
      for (const b of normalized) {
        if (!b.reason) b.reason = rx.businesses.find((r) => normalize(r.name) === normalize(b.name))?.reason ?? '';
      }
      businesses = normalized;
    } catch (err) {
      notes = `claude extraction failed: ${errorMessage(err)}`;
    }
  }

  // mentioned は aliases の文字列一致で決める（仕様）。順位は業者の出現順
  const mentioned = rx.mentioned;
  let rank: number | null = null;
  if (mentioned) {
    const i = businesses.findIndex((b) => b.isTarget);
    rank = i >= 0 ? i + 1 : (rx.businesses.findIndex((b) => b.isTarget) + 1 || null);
  }

  const competitorsMentioned = [
    ...new Set([
      ...rx.competitorsMentioned,
      ...businesses.filter((b) => !b.isTarget).map((b) => b.name),
    ]),
  ];

  return {
    extraction: {
      ...base,
      mentioned,
      rank,
      citedOwnSite: rx.citedOwnSite,
      competitorsMentioned,
      businesses,
      citedDomains: rx.citedDomains,
      method,
      ...(model ? { model } : {}),
      ...(notes ? { notes } : {}),
    },
    claudeUsed,
    costUsd,
  };
}

function estimateExtractUsdFromUsage(model: string, inputTokens: number, outputTokens: number): number {
  // pricing.ts の Haiku 単価に合わせる（未知モデルは Haiku 換算）
  const perCall = estimateExtractUsd(model);
  const assumed = 2000 + 400;
  return perCall * ((inputTokens + outputTokens) / assumed);
}

/** run ディレクトリの raw/*.json を全部抽出して extracted/*.json に書く */
export async function extractRun(runDir: string, opts: ExtractOptions): Promise<ExtractSummary> {
  const raws = readJsonFiles<RawAnswer>(path.join(runDir, 'raw'));
  const outDir = path.join(runDir, 'extracted');
  fs.mkdirSync(outDir, { recursive: true });
  const log = opts.log ?? (() => {});
  const summary: ExtractSummary = { total: raws.length, extracted: 0, skipped: 0, claudeCalls: 0, claudeFallbacks: 0, costUsd: 0 };

  await mapPool(raws, opts.concurrency ?? 4, async (raw) => {
    const outFile = path.join(outDir, `${raw.id}.json`);
    if (!opts.force && fs.existsSync(outFile)) {
      summary.skipped++;
      return;
    }
    const { extraction, claudeUsed, costUsd } = await extractOne(raw, opts);
    writeJson(outFile, extraction);
    summary.extracted++;
    summary.costUsd += costUsd;
    if (claudeUsed) summary.claudeCalls++;
    else if (opts.useClaude && raw.status === 'ok') summary.claudeFallbacks++;
    log(
      `  ${raw.id.padEnd(22)} ${extraction.mentioned ? '言及あり' : '言及なし'} rank=${extraction.rank ?? '-'} own=${extraction.citedOwnSite ? 'Y' : 'N'} ${extraction.method}`,
    );
  });
  return summary;
}

/** Claude を使うべきか（モックまたはキーなしなら regex のみ） */
export function shouldUseClaude(): boolean {
  return !isMock() && hasAnthropicKey();
}
