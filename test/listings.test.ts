import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  describeListings,
  GBP,
  listedSites,
  listingSitesFor,
  loadListings,
  mockListings,
  parseListingResponse,
  saveListings,
  unknownSites,
  unlistedSites,
} from '../src/lib/listings.js';
import { estimateListingCheckUsd } from '../src/lib/pricing.js';
import type { TargetConfig } from '../src/lib/types.js';

function target(industry: string, extra: Partial<TargetConfig> = {}): TargetConfig {
  return {
    slug: 'x',
    name: 'テスト社',
    aliases: ['テスト社'],
    url: 'https://example.jp',
    industry,
    area: '大阪市',
    areaAliases: ['大阪'],
    competitors: [],
    ...extra,
  };
}

test('listingSitesFor: 業種に応じた主要サイト＋Google ビジネスプロフィール', () => {
  assert.deepEqual(listingSitesFor(target('不動産売買・買取仲介')), [GBP, 'SUUMO', "LIFULL HOME'S", 'at home']);
  assert.deepEqual(listingSitesFor(target('出張買取（貴金属・時計）')), [GBP, 'ヒカカク！', 'おいくら', 'ウリドキ']);
  assert.deepEqual(listingSitesFor(target('訪問介護・居宅介護')), [GBP, '介護サービス情報公表システム', 'WAM NET']);
  // 「不動産買取」は買取より不動産を優先する
  assert.equal(listingSitesFor(target('不動産買取'))[1], 'SUUMO');
  // 分からない業種は汎用の口コミ・電話帳サイト
  assert.deepEqual(listingSitesFor(target('コンサルティング')), [GBP, 'エキテン', 'iタウンページ']);
});

test('listingSitesFor: config の listingSites があればそれを使う（重複除去）', () => {
  assert.deepEqual(listingSitesFor(target('不動産', { listingSites: ['SUUMO', ' SUUMO ', 'Yahoo!不動産', ''] })), ['SUUMO', 'Yahoo!不動産']);
});

const SITES = [GBP, 'SUUMO', "LIFULL HOME'S", 'at home'];

test('parseListingResponse: 表記ゆれを正規化し、要求したサイトの並びに揃える', () => {
  const text = `\`\`\`json
{"sites":[
  {"site":"SUUMO","status":"掲載あり","url":"https://suumo.jp/company/123","evidence":"会社ページ\\nあり"},
  {"site":"lifull home's","status":"not listed","evidence":"同名の別会社のみ"},
  {"site":"at home","status":"LISTED"},
  {"site":"食べログ","status":"listed","url":"https://tabelog.com/x"}
]}
\`\`\``;
  const out = parseListingResponse(text, SITES);
  assert.deepEqual(
    out.map((s) => [s.site, s.status]),
    [
      [GBP, 'unknown'], // 返ってこなかった
      ['SUUMO', 'listed'],
      ["LIFULL HOME'S", 'not_listed'],
      ['at home', 'unknown'], // listed だが URL が無いので根拠不足
    ],
  );
  assert.equal(out[1]!.url, 'https://suumo.jp/company/123');
  assert.equal(out[1]!.evidence, '会社ページ あり');
  assert.equal(out[2]!.url, undefined);
  // 一覧に無い食べログは捨てる
  assert.equal(out.some((s) => s.site === '食べログ'), false);
});

test('parseListingResponse: JSON でなければ全部 unknown', () => {
  const out = parseListingResponse('検索できませんでした', SITES);
  assert.equal(out.length, SITES.length);
  assert.equal(out.every((s) => s.status === 'unknown'), true);
});

test('parseListingResponse: URL が不正な listed は unknown に落とす', () => {
  const out = parseListingResponse('{"sites":[{"site":"SUUMO","status":"listed","url":"javascript:alert(1)"}]}', ['SUUMO']);
  assert.equal(out[0]!.status, 'unknown');
  assert.equal(out[0]!.url, undefined);
});

test('mockListings: 先頭 2 つが掲載あり、3 つ目が掲載なし、残りは不明', () => {
  const check = mockListings(target('不動産'));
  assert.equal(check.source, 'mock');
  assert.deepEqual(listedSites(check), [GBP, 'SUUMO']);
  assert.deepEqual(unlistedSites(check), ["LIFULL HOME'S"]);
  assert.deepEqual(unknownSites(check), ['at home']);
  assert.equal(check.costUsd, 0);
});

test('describeListings: 1 行ずつ、掲載ありには URL を添える', () => {
  const lines = describeListings(mockListings(target('不動産')));
  assert.equal(lines[1], '- SUUMO: 掲載あり（https://example.com/mock/2） — モックの掲載ページ');
  assert.equal(lines[2], "- LIFULL HOME'S: 掲載なし");
  assert.equal(lines[3], '- at home: 不明');
});

test('estimateListingCheckUsd: サイト数で増え、既定 4 サイトで 20 円前後', () => {
  const four = estimateListingCheckUsd('claude-opus-5', 4);
  assert.equal(four > estimateListingCheckUsd('claude-opus-5', 2), true);
  assert.equal(four > 0.1 && four < 0.2, true, `${four}`);
});

test('loadListings / saveListings: run ディレクトリに残して読み直せる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-scan-listings-'));
  try {
    assert.equal(loadListings(dir), null);
    const check = mockListings(target('不動産'));
    saveListings(dir, check);
    assert.deepEqual(loadListings(dir), check);
    fs.writeFileSync(path.join(dir, 'listings.json'), '{broken');
    assert.equal(loadListings(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
