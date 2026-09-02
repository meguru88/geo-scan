import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadEnv } from '../src/lib/env.js';

test('loadEnv: 引用符つきの値の後ろのコメントを無視し、引用符を残さない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-scan-env-'));
  fs.writeFileSync(
    path.join(dir, '.env'),
    ['# comment', 'GEO_TEST_A="sk-test-abcdefghijklmnop" # main key', "GEO_TEST_B='single'", 'GEO_TEST_C=plain value # trailing', 'GEO_TEST_D=', 'export GEO_TEST_E=exported'].join('\n'),
  );
  for (const k of ['GEO_TEST_A', 'GEO_TEST_B', 'GEO_TEST_C', 'GEO_TEST_D', 'GEO_TEST_E']) delete process.env[k];
  loadEnv(dir);
  assert.equal(process.env.GEO_TEST_A, 'sk-test-abcdefghijklmnop');
  assert.equal(process.env.GEO_TEST_B, 'single');
  assert.equal(process.env.GEO_TEST_C, 'plain value');
  assert.equal(process.env.GEO_TEST_D, '');
  assert.equal(process.env.GEO_TEST_E, 'exported');
});
