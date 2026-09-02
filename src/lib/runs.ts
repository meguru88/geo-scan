import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/** ローカル時刻の YYYY-MM-DD */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function assertDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${date}`);
  return date;
}

export function runsRoot(slug: string): string {
  return path.join(ROOT, 'runs', slug);
}

export function dateDir(slug: string, date: string): string {
  return path.join(runsRoot(slug), date);
}

/** 同日同slugの再実行は raw を上書きせず run-2, run-3 … に分ける */
export function newRunDir(slug: string, date: string): string {
  const base = dateDir(slug, date);
  if (!fs.existsSync(path.join(base, 'raw'))) return base;
  let n = 2;
  while (fs.existsSync(path.join(base, `run-${n}`, 'raw'))) n++;
  return path.join(base, `run-${n}`);
}

/** その日の最新の run ディレクトリ（run-N があれば最大の N、なければ日付ディレクトリ） */
export function latestRunDir(slug: string, date: string): string | null {
  const base = dateDir(slug, date);
  if (!fs.existsSync(base)) return null;
  const runs = fs
    .readdirSync(base)
    .filter((d) => /^run-\d+$/.test(d))
    .map((d) => Number(d.slice(4)))
    .sort((a, b) => b - a);
  const top = runs[0];
  return top !== undefined ? path.join(base, `run-${top}`) : base;
}

export function listDates(slug: string): string[] {
  const root = runsRoot(slug);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

export function latestDate(slug: string): string | null {
  const dates = listDates(slug);
  return dates[dates.length - 1] ?? null;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readJsonFiles<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T);
}

export function rel(p: string): string {
  return path.relative(ROOT, p) || '.';
}
