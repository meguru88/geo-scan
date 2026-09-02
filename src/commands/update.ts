import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { flagBool, flagString, parseArgs } from '../lib/args.js';
import { ROOT } from '../lib/config.js';
import { confirm } from '../lib/prompt.js';
import { applyPlan, KEEP_DIRS, planIsEmpty, planUpdate, walkLocal, type UpdatePlan } from '../lib/update.js';
import { stripRoot, unzip, zipComment, type ZipEntry } from '../lib/zip.js';

const DEFAULT_REPO = 'meguru88/geo-scan';
const DEFAULT_BRANCH = 'main';
const VERSION_FILE = '.geo-scan-version.json';
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const USAGE = '使い方: npm run update [-- --branch main] [--check] [--yes] [--zip <ダウンロード済みのzip>]';

interface VersionInfo {
  repo: string;
  branch: string;
  commit: string;
  updatedAt: string;
}

/** package.json の repository から owner/repo を取り出す */
function repoFromPackageJson(pkgText: string): string | null {
  try {
    const pkg = JSON.parse(pkgText) as { repository?: string | { url?: string } };
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url ?? '');
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function normalizeRepo(repo: string): string {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim());
  if (!m) throw new Error(`--repo は owner/name の形で指定してください: ${repo}`);
  return `${m[1]}/${m[2]}`;
}

function readVersion(): VersionInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, VERSION_FILE), 'utf8')) as VersionInfo;
  } catch {
    return null;
  }
}

function writeVersion(info: VersionInfo): void {
  fs.writeFileSync(path.join(ROOT, VERSION_FILE), JSON.stringify(info, null, 2) + '\n');
}

/** 非公開リポジトリ用のトークン。.env の GITHUB_TOKEN でも環境変数でもよい */
function githubToken(): string | undefined {
  const v = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return v && v.trim() ? v.trim() : undefined;
}

const TOKEN_HINT =
  'このリポジトリが非公開の場合は、GitHub の Personal Access Token（Contents の read 権限）を .env に GITHUB_TOKEN=ghp_… と書いてください。' +
  'または zip を手でダウンロードして npm run update -- --zip <ファイル> を実行してください';

async function tryDownload(url: string, token: string | undefined): Promise<Buffer> {
  const headers: Record<string, string> = { 'user-agent': 'geo-scan-update' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers.accept = 'application/vnd.github+json';
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ZIP_BYTES) throw new Error(`zip が大きすぎます（${(declared / 1024 / 1024).toFixed(0)}MB）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('zip が空でした');
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`zip が大きすぎます（${(buf.length / 1024 / 1024).toFixed(0)}MB）`);
  return buf;
}

async function downloadZip(repo: string, branch: string): Promise<Buffer> {
  const token = githubToken();
  // トークンがあれば API 経由（非公開リポジトリの正規の取得方法）。
  // 失敗しても codeload を試す（環境によってどちらか一方しか通らないことがある）
  const urls = token
    ? [`https://api.github.com/repos/${repo}/zipball/${branch}`, `https://codeload.github.com/${repo}/zip/refs/heads/${branch}`]
    : [`https://codeload.github.com/${repo}/zip/refs/heads/${branch}`];

  const failures: string[] = [];
  for (const url of urls) {
    console.log(`  ダウンロード中: ${url}${token ? '（GITHUB_TOKEN を使用）' : ''}`);
    try {
      return await tryDownload(url, token);
    } catch (err) {
      failures.push(`${new URL(url).hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  throw new Error(
    `zip をダウンロードできませんでした（${failures.join(' / ')}）。\n` +
      (token ? '  トークンにこのリポジトリの Contents: read 権限があるか確認してください。\n' : `  ${TOKEN_HINT}。\n`) +
      (proxy ? '  プロキシ環境では NODE_USE_ENV_PROXY=1 を付けて実行してください。\n' : '') +
      '  つながらない場合は zip を手でダウンロードして npm run update -- --zip <ファイル> を実行してください',
  );
}

function packageName(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

/** 取り違え防止。展開した中身が本当に geo-scan か確かめる */
function assertIsGeoScan(entries: readonly ZipEntry[]): void {
  const pkg = entries.find((e) => e.path === 'package.json');
  if (!pkg || !entries.some((e) => e.path === 'src/cli.ts')) {
    throw new Error('zip の中身が geo-scan ではありません（package.json / src/cli.ts が見つかりません）');
  }
  const name = packageName(pkg.data.toString('utf8'));
  if (name !== 'geo-scan') throw new Error(`zip の中身が geo-scan ではありません（name: ${name ?? '読み取れません'}）`);
}

/** dependencies / devDependencies が変わったか（変わっていれば npm install が要る） */
function depsChanged(before: string, after: string): boolean {
  const deps = (text: string): string => {
    const pkg = JSON.parse(text) as { dependencies?: unknown; devDependencies?: unknown };
    return JSON.stringify([pkg.dependencies ?? {}, pkg.devDependencies ?? {}]);
  };
  try {
    return deps(before) !== deps(after);
  } catch {
    return true;
  }
}

function printList(mark: string, label: string, paths: readonly string[], limit = 12): void {
  if (paths.length === 0) return;
  console.log(`  ${label}（${paths.length} 件）`);
  for (const p of paths.slice(0, limit)) console.log(`    ${mark} ${p}`);
  if (paths.length > limit) console.log(`    …ほか ${paths.length - limit} 件`);
}

function printPlan(plan: UpdatePlan): void {
  console.log(`\n■ 入れ替える内容: 追加 ${plan.added.length} / 変更 ${plan.changed.length} / 削除 ${plan.deletes.length} / そのまま ${plan.unchanged.length}`);
  printList('+', '追加', plan.added);
  printList('~', '変更', plan.changed);
  printList('-', '削除', plan.deletes);
  console.log(`  残すもの: .env / runs/ / ${KEEP_DIRS.map((d) => `${d}/`).join(' / ')} / node_modules/`);
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (flagBool(args, 'help')) {
    console.log(USAGE);
    return;
  }
  const pkgFile = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgFile)) throw new Error(`geo-scan のフォルダで実行してください（${ROOT} に package.json がありません）`);
  const pkgBefore = fs.readFileSync(pkgFile, 'utf8');
  if (packageName(pkgBefore) !== 'geo-scan') {
    throw new Error(`geo-scan のフォルダで実行してください（${ROOT} は別のプロジェクトです）`);
  }

  const branch = flagString(args, 'branch') ?? DEFAULT_BRANCH;
  const repo = normalizeRepo(flagString(args, 'repo') ?? process.env.GEO_SCAN_REPO ?? repoFromPackageJson(pkgBefore) ?? DEFAULT_REPO);
  const zipFile = flagString(args, 'zip');
  const check = flagBool(args, 'check');
  const current = readVersion();

  console.log(`■ geo-scan を更新します（${repo} の ${branch}）`);
  console.log(`  フォルダ: ${ROOT}`);
  if (current) console.log(`  今の版  : ${current.commit.slice(0, 7)}（${current.updatedAt} に更新）`);
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('  ※ このフォルダは git 管理下です。git pull でも更新できます（このコマンドは git を使いません）');
  }

  const buf = zipFile ? fs.readFileSync(path.resolve(zipFile)) : await downloadZip(repo, branch);
  const commit = zipComment(buf) || 'unknown';
  const entries = stripRoot(unzip(buf));
  assertIsGeoScan(entries);
  console.log(`  取得した版: ${commit.slice(0, 7)}（${entries.length} ファイル / ${(buf.length / 1024).toFixed(0)}KB）`);

  const plan = planUpdate(entries, walkLocal(ROOT));
  if (planIsEmpty(plan)) {
    console.log('\nすでに最新です。入れ替えるファイルはありません。');
    if (commit !== 'unknown') writeVersion({ repo, branch, commit, updatedAt: new Date().toISOString() });
    return;
  }
  printPlan(plan);

  if (check) {
    console.log('\n--check なので入れ替えは行いませんでした。更新するには npm run update を実行してください。');
    return;
  }
  if (!flagBool(args, 'yes')) {
    const ok = await confirm('\nこの内容で入れ替えますか？ [y/N] ');
    if (!ok) {
      console.log('更新しませんでした。');
      return;
    }
  }

  const result = applyPlan(ROOT, plan);
  writeVersion({ repo, branch, commit, updatedAt: new Date().toISOString() });
  console.log(`\n■ 更新しました: ${result.written} ファイルを入れ替え、${result.deleted} ファイルを削除（版 ${commit.slice(0, 7)}）`);

  const pkgAfter = fs.readFileSync(pkgFile, 'utf8');
  if (depsChanged(pkgBefore, pkgAfter)) {
    if (flagBool(args, 'no-install')) {
      console.log('  依存パッケージが変わりました。`npm install` を実行してください。');
    } else {
      console.log('\n■ 依存パッケージが変わったので npm install を実行します…');
      const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(cmd, ['install'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) {
        console.log('  npm install に失敗しました。手で `npm install` を実行してください。');
        process.exitCode = 1;
        return;
      }
    }
  }
  console.log('\n完了しました。`npm run report -- <slug>` などはそのまま使えます（.env と runs は残しています）。');
}
