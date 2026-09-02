import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flagBool, flagNumber, flagString, parseArgs } from '../src/lib/args.js';
import { redact } from '../src/lib/redact.js';

test('parseArgs: 位置引数とフラグ', () => {
  const a = parseArgs(['meguru', '--runs', '3', '--mock', '--compare=2026-09-01', 'extra']);
  assert.deepEqual(a.positionals, ['meguru', 'extra']);
  assert.equal(flagNumber(a, 'runs', 1), 3);
  assert.equal(flagBool(a, 'mock'), true);
  assert.equal(flagString(a, 'compare'), '2026-09-01');
  assert.equal(flagNumber(a, 'max-cost', 500), 500);
});

test('parseArgs: 真偽フラグは後ろの位置引数を飲み込まない', () => {
  const a = parseArgs(['--mock', 'meguru', '--no-pdf', 'extra']);
  assert.deepEqual(a.positionals, ['meguru', 'extra']);
  assert.equal(flagBool(a, 'mock'), true);
  assert.equal(flagBool(a, 'no-pdf'), true);
});

test('flagNumber: 数値でなければエラー', () => {
  assert.throws(() => flagNumber(parseArgs(['--runs', 'abc']), 'runs', 1), /runs/);
});

test('redact: APIキーらしき文字列を伏せる', () => {
  const s = redact('key sk-proj-abcdefghijklmnop and AIzaSyA1234567890abcdefghijklmnopq and pplx-abcdefghijk and sk-ant-api03-xxxxxxxxxx');
  assert.equal(s.includes('sk-proj-'), false);
  assert.equal(s.includes('AIza'), false);
  assert.equal(s.includes('pplx-'), false);
  assert.equal(s.includes('sk-ant-'), false);
});
