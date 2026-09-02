import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manualRowToExtraction, parseCsv, parseManualCsv } from '../src/lib/manual.js';
import type { TargetConfig } from '../src/lib/types.js';

const target: TargetConfig = {
  slug: 'meguru',
  name: 'めぐる買取',
  aliases: ['めぐる買取'],
  url: 'https://meguru-kaitori.jp',
  industry: '出張買取',
  area: '大阪市東住吉区',
  areaAliases: ['東住吉区'],
  competitors: ['おたからや', '買取大吉'],
};

test('parseCsv: クォート・改行・BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', 'x, y', 'say "hi"'],
  ]);
});

test('parseManualCsv: 列の検証と型変換', () => {
  const rows = parseManualCsv(
    'date,engine,question_no,mentioned,rank,cited_own,competitors,notes\n2026-09-02,Google-AIO,2,1,2,1,おたからや;買取大吉,memo\n2026-09-02,google_aio,3,0,,0,,\n',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.engine, 'google_aio');
  assert.equal(rows[0]?.rank, 2);
  assert.equal(rows[0]?.citedOwn, true);
  assert.deepEqual(rows[0]?.competitors, ['おたからや', '買取大吉']);
  assert.equal(rows[1]?.mentioned, false);
  assert.equal(rows[1]?.rank, null);
});

test('parseManualCsv: 必須列がなければエラー', () => {
  assert.throws(() => parseManualCsv('date,engine\n2026-09-02,x\n'), /question_no/);
});

test('manualRowToExtraction: rank の位置に自社を差し込む', () => {
  const [row] = parseManualCsv('date,engine,question_no,mentioned,rank,cited_own,competitors\n2026-09-02,google_aio,1,1,2,1,おたからや;買取大吉\n');
  const ex = manualRowToExtraction(row!, 1, target, 'meguru-kaitori.jp');
  assert.equal(ex.id, 'google_aio-q01-r1');
  assert.deepEqual(ex.businesses.map((b) => b.name), ['おたからや', 'めぐる買取', '買取大吉']);
  assert.equal(ex.rank, 2);
  assert.deepEqual(ex.citedDomains, ['meguru-kaitori.jp']);
  assert.equal(ex.source, 'manual');
});
