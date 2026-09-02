import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyPlan, isKeptPath, isUserFile, planIsEmpty, planUpdate, sha256, walkLocal } from '../src/lib/update.js';
import type { ZipEntry } from '../src/lib/zip.js';

function entry(p: string, text: string): ZipEntry {
  return { path: p, data: Buffer.from(text, 'utf8'), executable: false };
}

/** 相対パス → 中身 から walkLocal と同じ形（パス → ハッシュ）を作る */
function localOf(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files).map(([p, text]) => [p, sha256(Buffer.from(text, 'utf8'))]));
}

function tmpProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-scan-test-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test('isUserFile: .env は守るが .env.example は更新する', () => {
  assert.equal(isUserFile('.env'), true);
  assert.equal(isUserFile('.env.local'), true);
  assert.equal(isUserFile('.env.example'), false);
  assert.equal(isUserFile('src/env.ts'), false);
});

test('isKeptPath: config/targets と config/questions の中だけ', () => {
  assert.equal(isKeptPath('config/targets/meguru.json'), true);
  assert.equal(isKeptPath('config/questions/royg.json'), true);
  assert.equal(isKeptPath('config/other.json'), false);
  assert.equal(isKeptPath('src/lib/config.ts'), false);
});

test('planUpdate: 追加・変更・変更なしを見分ける', () => {
  const next = [entry('README.md', '新しい説明'), entry('src/lib/zip.ts', 'zip'), entry('package.json', '{"a":1}')];
  const local = localOf({ 'README.md': '古い説明', 'package.json': '{"a":1}' });
  const plan = planUpdate(next, local);
  assert.deepEqual(plan.added, ['src/lib/zip.ts']);
  assert.deepEqual(plan.changed, ['README.md']);
  assert.deepEqual(plan.unchanged, ['package.json']);
  assert.deepEqual(plan.deletes, []);
  assert.equal(plan.writes.length, 2);
  assert.equal(planIsEmpty(plan), false);
  assert.equal(planIsEmpty(planUpdate([entry('a.txt', 'x')], localOf({ 'a.txt': 'x' }))), true);
});

test('planUpdate: .env と診断データは書き換えない', () => {
  const next = [
    entry('.env', 'OPENAI_API_KEY=zip の中の値'),
    entry('.env.example', 'OPENAI_API_KEY=\nGEMINI_API_KEY='),
    entry('config/targets/meguru.json', '{"slug":"meguru","new":true}'),
    entry('config/questions/meguru.json', '{"slug":"meguru","new":true}'),
    entry('config/targets/sample.json', '{"slug":"sample"}'),
  ];
  const local = localOf({
    '.env': 'OPENAI_API_KEY=sk-本物',
    '.env.example': 'OPENAI_API_KEY=',
    'config/targets/meguru.json': '{"slug":"meguru","competitors":["おたからや"]}',
    'config/questions/meguru.json': '{"slug":"meguru","questions":[]}',
  });
  const plan = planUpdate(next, local);
  // 手元の設定はそのまま、新しい版にしかない設定だけ足す
  assert.deepEqual(plan.added, ['config/targets/sample.json']);
  assert.deepEqual(plan.changed, ['.env.example']);
  assert.deepEqual(plan.kept.sort(), ['.env', 'config/questions/meguru.json', 'config/targets/meguru.json']);
  assert.equal(plan.writes.some((w) => w.path === '.env'), false);
  assert.equal(plan.deletes.length, 0);
});

test('planUpdate: 新しい版で消えたソースは消すが、利用者が置いたファイルは消さない', () => {
  const next = [entry('src/cli.ts', 'cli'), entry('config/targets/meguru.json', '{}')];
  const local = localOf({
    'src/cli.ts': 'cli',
    'src/lib/old.ts': '前の版にあったファイル',
    'config/targets/meguru.json': '{}',
    'config/targets/自分で足した.json': '{}',
    'config/questions/meguru.json': '{}',
    'メモ.txt': 'フォルダ直下に置いた自分のメモ',
    'runs/manual.csv': '手入力の結果',
  });
  const plan = planUpdate(next, local);
  // src は新しい版にもあるディレクトリなので、無くなったファイルを掃除する
  assert.deepEqual(plan.deletes, ['src/lib/old.ts']);
  assert.equal(plan.deletes.includes('メモ.txt'), false);
  assert.equal(plan.deletes.includes('runs/manual.csv'), false);
  assert.equal(plan.deletes.includes('config/targets/自分で足した.json'), false);
});

test('walkLocal: runs・node_modules・.git は見に行かない', () => {
  const root = tmpProject({
    'package.json': '{"name":"geo-scan"}',
    'src/cli.ts': 'cli',
    '.env': 'KEY=1',
    'config/targets/meguru.json': '{}',
    'runs/meguru/2026-09-02/report.html': '<html>',
    'node_modules/foo/index.js': 'x',
    '.git/HEAD': 'ref',
    'dist/cli.js': 'built',
  });
  try {
    const local = walkLocal(root);
    assert.deepEqual([...local.keys()].sort(), ['.env', 'config/targets/meguru.json', 'package.json', 'src/cli.ts']);
    assert.equal(local.get('src/cli.ts'), sha256(Buffer.from('cli')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan: 入れ替えても .env と runs と設定が残る', () => {
  const root = tmpProject({
    'package.json': '{"name":"geo-scan","version":"0.1.0"}',
    'README.md': '古い説明',
    'src/cli.ts': 'cli',
    'src/lib/old.ts': '消える予定',
    '.env': 'OPENAI_API_KEY=sk-本物',
    'config/targets/meguru.json': '{"slug":"meguru"}',
    'runs/meguru/2026-09-02/report.html': '<html>レポート</html>',
  });
  try {
    const next = [
      entry('package.json', '{"name":"geo-scan","version":"0.2.0"}'),
      entry('README.md', '新しい説明'),
      entry('src/cli.ts', 'cli'),
      entry('src/lib/zip.ts', 'zip'),
      entry('config/targets/meguru.json', '{"slug":"meguru","上書きされない":true}'),
    ];
    const plan = planUpdate(next, walkLocal(root));
    const result = applyPlan(root, plan);

    assert.equal(result.written, 3); // package.json / README.md / src/lib/zip.ts
    assert.equal(result.deleted, 1); // src/lib/old.ts
    const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');
    assert.equal(read('README.md'), '新しい説明');
    assert.equal(read('src/lib/zip.ts'), 'zip');
    assert.equal(read('.env'), 'OPENAI_API_KEY=sk-本物');
    assert.equal(read('config/targets/meguru.json'), '{"slug":"meguru"}');
    assert.equal(read('runs/meguru/2026-09-02/report.html'), '<html>レポート</html>');
    assert.equal(fs.existsSync(path.join(root, 'src/lib/old.ts')), false);
    // 空になったディレクトリは残さない
    assert.equal(fs.existsSync(path.join(root, 'src/lib')), true); // zip.ts があるので残る
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan: 空になったディレクトリを片付ける', () => {
  const root = tmpProject({ 'src/cli.ts': 'cli', 'src/old/gone.ts': 'x' });
  try {
    applyPlan(root, planUpdate([entry('src/cli.ts', 'cli')], walkLocal(root)));
    assert.equal(fs.existsSync(path.join(root, 'src/old')), false);
    assert.equal(fs.existsSync(path.join(root, 'src')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan: 途中で失敗したら元の状態に戻す', () => {
  const root = tmpProject({ 'README.md': '古い説明', 'src/lib/keep.ts': 'keep', 'blocked/inside.txt': 'x' });
  try {
    // 2 件目はディレクトリと同名なので書き込みに失敗する
    const plan = planUpdate([entry('README.md', '新しい説明'), entry('blocked', 'ファイルとして書けない')], walkLocal(root));
    assert.throws(() => applyPlan(root, plan), /元の状態に戻しました/);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '古い説明');
    assert.equal(fs.readFileSync(path.join(root, 'blocked/inside.txt'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(root, 'src/lib/keep.ts'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyPlan: 新しく作ったファイルも失敗時に取り消す', () => {
  const root = tmpProject({ 'src/cli.ts': 'cli', 'blocked/inside.txt': 'x' });
  try {
    const plan = planUpdate([entry('src/cli.ts', 'cli'), entry('src/lib/new.ts', '新規'), entry('blocked', 'x')], walkLocal(root));
    assert.throws(() => applyPlan(root, plan), /元の状態に戻しました/);
    assert.equal(fs.existsSync(path.join(root, 'src/lib/new.ts')), false);
    assert.equal(fs.existsSync(path.join(root, 'src/lib')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
