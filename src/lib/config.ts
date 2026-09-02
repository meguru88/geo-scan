import fs from 'node:fs';
import path from 'node:path';
import type { QuestionSet, TargetConfig } from './types.js';

export const ROOT = process.cwd();

export function targetPath(slug: string): string {
  return path.join(ROOT, 'config', 'targets', `${slug}.json`);
}

export function questionsPath(slug: string): string {
  return path.join(ROOT, 'config', 'questions', `${slug}.json`);
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    throw new Error(`slug が不正です: ${slug}（英数字・-・_ のみ）`);
  }
}

export function loadTarget(slug: string): TargetConfig {
  assertSlug(slug);
  const file = targetPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`対象設定が見つかりません: ${path.relative(ROOT, file)}`);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TargetConfig>;
  const required: (keyof TargetConfig)[] = ['slug', 'name', 'aliases', 'url', 'industry', 'area', 'areaAliases', 'competitors'];
  for (const k of required) {
    if (json[k] === undefined || json[k] === null) throw new Error(`${path.relative(ROOT, file)}: "${k}" がありません`);
  }
  const t = json as TargetConfig;
  if (t.slug !== slug) throw new Error(`${path.relative(ROOT, file)}: slug (${t.slug}) がファイル名と一致しません`);
  if (!Array.isArray(t.aliases) || t.aliases.length === 0) throw new Error('aliases は1件以上必要です');
  if (!t.aliases.includes(t.name)) t.aliases = [t.name, ...t.aliases];
  t.aliases = t.aliases.map((a) => String(a).trim()).filter(Boolean);
  const short = t.aliases.find((a) => a.normalize('NFKC').replace(/\s+/g, '').length < 2);
  if (short !== undefined) throw new Error(`aliases に短すぎる別名があります（2 文字以上にしてください）: "${short}"`);
  if (!Array.isArray(t.competitors)) throw new Error('competitors は配列で指定してください');
  t.competitors = t.competitors.map((c) => String(c).trim()).filter(Boolean);
  try {
    new URL(t.url);
  } catch {
    throw new Error(`url が不正です: ${t.url}`);
  }
  if (t.searchLocation) {
    const c = t.searchLocation.country;
    if (c !== undefined && !/^[A-Z]{2}$/.test(c)) throw new Error(`searchLocation.country は ISO 3166-1 の 2 文字（例: JP）で指定してください: ${c}`);
    const { latitude, longitude } = t.searchLocation;
    if ((latitude === undefined) !== (longitude === undefined)) throw new Error('searchLocation の latitude と longitude は両方指定してください');
  }
  return t;
}

export function loadQuestions(slug: string): QuestionSet {
  assertSlug(slug);
  const file = questionsPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`質問ファイルがありません: ${path.relative(ROOT, file)}。先に \`npm run questions -- ${slug}\` を実行してください`);
  }
  const qs = JSON.parse(fs.readFileSync(file, 'utf8')) as QuestionSet;
  if (!Array.isArray(qs.questions) || qs.questions.length === 0) throw new Error('questions が空です');
  qs.questions.forEach((q, i) => {
    if (typeof q.no !== 'number' || typeof q.text !== 'string') {
      throw new Error(`questions[${i}] の形式が不正です（no: number, text: string が必要）`);
    }
  });
  return qs;
}

export function saveQuestions(qs: QuestionSet): string {
  const file = questionsPath(qs.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(qs, null, 2) + '\n');
  return file;
}

/** ホスト名から www. を除いた「ドメイン」を返す。URL でなければ null */
export function domainOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

export function ownDomain(target: TargetConfig): string {
  const d = domainOf(target.url);
  if (!d) throw new Error(`url からドメインを取得できません: ${target.url}`);
  return d;
}
