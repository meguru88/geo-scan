import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ZipEntry } from './zip.js';

/**
 * 「新しい版のファイル一式」と「今のフォルダ」を突き合わせて、
 * 利用者のデータを残したまま入れ替える計画を立てる。
 *
 * 残すもの:
 * - `.env`（API キー）… 新しい版にも入っていないが、念のため書き換え対象から外す
 * - `runs/`（計測結果）… そもそも見に行かない
 * - `config/targets/` `config/questions/`（診断対象と質問）… 既存ファイルは触らず、新しい版にしか無いものだけ追加
 * - `node_modules/` `.git/`（自分で作り直せるもの・git の管理下）
 *
 * 消すもの: 新しい版で無くなったファイル。ただし「新しい版にもあるトップレベルのディレクトリ」の中だけ。
 * 利用者がフォルダ直下に置いた CSV やメモは消さない。
 */

/** 中身を見に行かないディレクトリ（トップレベル） */
export const SKIP_ROOT_DIRS: readonly string[] = ['runs', 'dist'];
/** どの階層にあっても見に行かないディレクトリ */
export const SKIP_ANY_DIRS: readonly string[] = ['node_modules', '.git'];
/** 中のファイルを保護するディレクトリ（既存は触らず、削除もしない） */
export const KEEP_DIRS: readonly string[] = ['config/targets', 'config/questions'];

/** 8MB を超えるファイルは中身を読まない（更新対象のソースにこの大きさのものは無い） */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 利用者が書いた .env 系か（.env.example はリポジトリ側のファイルなので更新する） */
export function isUserFile(rel: string): boolean {
  return rel === '.env' || (rel.startsWith('.env.') && rel !== '.env.example');
}

/** 中身を保護するディレクトリの中か */
export function isKeptPath(rel: string): boolean {
  return KEEP_DIRS.some((d) => rel.startsWith(`${d}/`));
}

function topDir(rel: string): string {
  const i = rel.indexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** 今のフォルダのファイル一覧（相対パス → 中身の SHA-256）。保護ディレクトリは走査しない */
export function walkLocal(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_ANY_DIRS.includes(ent.name)) continue;
        if (!prefix && SKIP_ROOT_DIRS.includes(ent.name)) continue;
        walk(path.join(dir, ent.name), rel);
        continue;
      }
      if (!ent.isFile()) continue;
      const file = path.join(dir, ent.name);
      const size = fs.statSync(file).size;
      out.set(rel, size > MAX_HASH_BYTES ? `size:${size}` : sha256(fs.readFileSync(file)));
    }
  };
  walk(root, '');
  return out;
}

export interface UpdatePlan {
  /** 書き込むファイル（中身つき） */
  writes: ZipEntry[];
  /** writes のうち新規追加のパス */
  added: string[];
  /** writes のうち既存を書き換えるパス */
  changed: string[];
  /** 新しい版で無くなったので消すパス */
  deletes: string[];
  /** 保護したので触らなかったパス */
  kept: string[];
  /** 中身が同じで触る必要がなかったパス */
  unchanged: string[];
}

export function planUpdate(next: readonly ZipEntry[], local: ReadonlyMap<string, string>): UpdatePlan {
  const plan: UpdatePlan = { writes: [], added: [], changed: [], deletes: [], kept: [], unchanged: [] };
  const nextPaths = new Set(next.map((e) => e.path));

  for (const entry of next) {
    const rel = entry.path;
    const current = local.get(rel);
    if (isUserFile(rel) || (isKeptPath(rel) && current !== undefined)) {
      plan.kept.push(rel);
      continue;
    }
    if (current !== undefined && current === sha256(entry.data)) {
      plan.unchanged.push(rel);
      continue;
    }
    plan.writes.push(entry);
    (current === undefined ? plan.added : plan.changed).push(rel);
  }

  // 削除は「新しい版にもあるディレクトリ」の中だけ。フォルダ直下の見知らぬファイルは残す
  const managed = new Set([...nextPaths].map(topDir).filter(Boolean));
  for (const rel of local.keys()) {
    if (nextPaths.has(rel) || isUserFile(rel) || isKeptPath(rel)) continue;
    const top = topDir(rel);
    if (top && managed.has(top)) plan.deletes.push(rel);
  }

  plan.added.sort();
  plan.changed.sort();
  plan.deletes.sort();
  return plan;
}

export function planIsEmpty(plan: UpdatePlan): boolean {
  return plan.writes.length === 0 && plan.deletes.length === 0;
}

function assertInside(root: string, file: string): void {
  const resolved = path.resolve(file);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`フォルダの外を書き換えようとしました: ${file}`);
  }
}

/** 書き換える前のファイルを退避する。戻り値はもともと存在したか */
function stash(root: string, backup: string, rel: string): boolean {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) return false;
  const to = path.join(backup, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

/** 空になった親ディレクトリを root まで遡って消す */
function pruneEmptyDirs(root: string, dir: string): void {
  let cur = path.resolve(dir);
  const stop = path.resolve(root);
  while (cur !== stop && cur.startsWith(stop + path.sep)) {
    if (fs.readdirSync(cur).length > 0) return;
    fs.rmdirSync(cur);
    cur = path.dirname(cur);
  }
}

function rollback(root: string, backup: string, done: readonly { rel: string; existed: boolean }[]): void {
  for (const { rel, existed } of [...done].reverse()) {
    const file = path.join(root, rel);
    try {
      if (existed) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(backup, rel), file);
      } else {
        fs.rmSync(file, { force: true });
        pruneEmptyDirs(root, path.dirname(file));
      }
    } catch {
      // 戻せなかったファイルがあっても残りは戻す（退避先は呼び出し元がエラーに載せる）
    }
  }
}

/**
 * 計画どおりに入れ替える。途中で失敗したら退避したファイルから元に戻す。
 * 成功したら退避先は消す。
 */
export function applyPlan(root: string, plan: UpdatePlan): { written: number; deleted: number } {
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-scan-update-'));
  const done: { rel: string; existed: boolean }[] = [];
  try {
    for (const entry of plan.writes) {
      const file = path.join(root, entry.path);
      assertInside(root, file);
      done.push({ rel: entry.path, existed: stash(root, backup, entry.path) });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.data);
      if (entry.executable) fs.chmodSync(file, 0o755);
    }
    for (const rel of plan.deletes) {
      const file = path.join(root, rel);
      assertInside(root, file);
      done.push({ rel, existed: stash(root, backup, rel) });
      fs.rmSync(file, { force: true });
      pruneEmptyDirs(root, path.dirname(file));
    }
  } catch (err) {
    rollback(root, backup, done);
    fs.rmSync(backup, { recursive: true, force: true });
    throw new Error(`更新に失敗したため元の状態に戻しました: ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return { written: plan.writes.length, deleted: plan.deletes.length };
}
