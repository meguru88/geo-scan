import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canStartNext, exceededBudget, formatBatchSummary, parseBatchCsv, type BatchResult, type BatchRow } from '../src/lib/batch.js';

test('parseBatchCsv: slug,url,name を読む（BOM・空白・任意列・列順の違い）', () => {
  const rows = parseBatchCsv('﻿name,slug,url,area\r\nヘルパーステーションRoyG, royg ,https://roygbiv.stars.ne.jp/,\n"めぐる買取",meguru,https://meguru-kaitori.jp,大阪市\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { line: 2, slug: 'royg', url: 'https://roygbiv.stars.ne.jp/', name: 'ヘルパーステーションRoyG' });
  assert.deepEqual(rows[1], { line: 3, slug: 'meguru', url: 'https://meguru-kaitori.jp', name: 'めぐる買取', area: '大阪市' });
});

test('parseBatchCsv: name は省略できる', () => {
  const rows = parseBatchCsv('slug,url\nroyg,https://roygbiv.stars.ne.jp/\n');
  assert.equal(rows[0]?.name, undefined);
});

test('parseBatchCsv: 必須列・データ行がなければエラー', () => {
  assert.throws(() => parseBatchCsv('slug,name\nroyg,x\n'), /"url"/);
  assert.throws(() => parseBatchCsv('url,name\nhttps://a.example,x\n'), /"slug"/);
  assert.throws(() => parseBatchCsv('slug,url,name\n'), /データ行/);
  assert.throws(() => parseBatchCsv(''), /空/);
});

test('parseBatchCsv: slug の不正・重複、url の不正は行番号つきでエラー', () => {
  assert.throws(() => parseBatchCsv('slug,url\nroy g,https://a.example\n'), /2 行目.*slug/);
  assert.throws(() => parseBatchCsv('slug,url\n,https://a.example\n'), /2 行目: slug が空/);
  assert.throws(() => parseBatchCsv('slug,url\na,https://a.example\nb,https://b.example\na,https://c.example\n'), /4 行目.*"a".*2 行目/);
  assert.throws(() => parseBatchCsv('slug,url\na,not-a-url\n'), /2 行目: url/);
  assert.throws(() => parseBatchCsv('slug,url\na,ftp://a.example\n'), /2 行目: url/);
});

test('予算: 上限に達したら次に進まず、超えたら止める', () => {
  assert.equal(canStartNext(0, 3000), true);
  assert.equal(canStartNext(2999.9, 3000), true);
  assert.equal(canStartNext(3000, 3000), false);
  assert.equal(exceededBudget(3000, 3000), false);
  assert.equal(exceededBudget(3000.1, 3000), true);
});

test('formatBatchSummary: 成功・失敗・未実行と PDF の一覧', () => {
  const row = (slug: string, name?: string): BatchRow => ({ line: 1, slug, url: `https://${slug}.example`, ...(name ? { name } : {}) });
  const results: BatchResult[] = [
    { row: row('royg', 'ヘルパーステーションRoyG'), status: 'ok', costJpy: 279.2, pdf: 'runs/royg/2026-09-03/report.pdf' },
    { row: row('bad'), status: 'failed', costJpy: 0, pdf: null, reason: 'HTTP 404' },
    { row: row('meguru'), status: 'ok', costJpy: 300, pdf: 'runs/meguru/2026-09-03/report.pdf' },
    { row: row('later'), status: 'skipped', costJpy: 0, pdf: null, reason: '累計費用が上限 ¥500 に達したため未実行' },
  ];
  const text = formatBatchSummary(results, 579.2, 500).join('\n');
  assert.match(text, /成功 2 \/ 失敗 1 \/ 未実行 1（全 4 社）/);
  assert.match(text, /合計費用 ¥579\.2（上限 --max-total-cost ¥500）/);
  assert.match(text, /royg\s+¥279\.2\s+ヘルパーステーションRoyG/);
  assert.match(text, /bad\s+¥0\.0\s+HTTP 404/);
  assert.match(text, /later\s+累計費用が上限/);
  assert.match(text, /レポート PDF 2 件\n  runs\/royg\/2026-09-03\/report\.pdf\n  runs\/meguru\/2026-09-03\/report\.pdf/);
});

test('formatBatchSummary: 未実行がなければその見出しを出さない', () => {
  const results: BatchResult[] = [{ row: { line: 2, slug: 'a', url: 'https://a.example' }, status: 'failed', costJpy: 0, pdf: null, reason: 'x' }];
  const text = formatBatchSummary(results, 0, 3000).join('\n');
  assert.equal(text.includes('未実行 0 社'), false);
  assert.match(text, /成功 0 社\n  （なし）/);
  assert.match(text, /レポート PDF 0 件\n  （なし）/);
});
