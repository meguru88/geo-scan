import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAggregate } from '../src/lib/aggregate.js';
import { GBP, type ListingCheck } from '../src/lib/listings.js';
import { candidatesFor, listingsPromptLines, templateAdvice } from '../src/lib/suggest.js';
import type { Extraction, TargetConfig } from '../src/lib/types.js';

const target: TargetConfig = {
  slug: 'gh',
  name: 'グリーンハウジング',
  aliases: ['グリーンハウジング'],
  url: 'https://example.jp',
  industry: '不動産売買・買取',
  area: '大阪市',
  areaAliases: ['大阪'],
  competitors: ['大手A'],
};

/** 掲載状況: SUUMO と HOME'S は掲載済み、at home は未掲載、Google ビジネスプロフィールは不明 */
const listings: ListingCheck = {
  checkedAt: '2026-09-03T00:00:00.000Z',
  source: 'claude',
  sites: [
    { site: GBP, status: 'unknown' },
    { site: 'SUUMO', status: 'listed', url: 'https://suumo.jp/x' },
    { site: "LIFULL HOME'S", status: 'listed', url: 'https://homes.co.jp/x' },
    { site: 'at home', status: 'not_listed' },
  ],
  searches: 4,
  usage: { inputTokens: 1, outputTokens: 1, searches: 4 },
  costUsd: 0.1,
};

function extraction(engine: string, questionNo: number): Extraction {
  return {
    id: `${engine}-q${questionNo}-r1`,
    engine,
    questionNo,
    runIndex: 1,
    status: 'ok',
    source: 'scan',
    mentioned: false,
    rank: null,
    citedOwnSite: false,
    competitorsMentioned: ['大手A'],
    businesses: [{ name: '大手A', isTarget: false, reason: '' }],
    citedDomains: ['suumo.jp'],
    method: 'regex',
    extractedAt: '2026-09-03T00:00:00.000Z',
  };
}

const agg = buildAggregate({
  slug: 'gh',
  date: '2026-09-03',
  runDir: '/tmp/none',
  target,
  questions: [1, 2].map((no) => ({ no, text: `Q${no}`, withArea: true })),
  extractions: [extraction('openai', 1), extraction('openai', 2)],
});

test('candidatesFor: 掲載状況が無ければ従来どおり「掲載を依頼」', () => {
  const third = candidatesFor(target, '2026-09-03').find((c) => c.key === 'third')!;
  assert.equal(third.title, '第三者サイトでの言及を増やす');
  assert.equal(third.action.includes('掲載を依頼'), true);
});

test('candidatesFor: 掲載済みのサイトには申込ではなく追記・更新を勧める', () => {
  const third = candidatesFor(target, '2026-09-03', listings).find((c) => c.key === 'third')!;
  assert.equal(third.title, '掲載済みサイトの情報を更新する');
  assert.equal(third.why.includes("SUUMO・LIFULL HOME'Sには掲載済み"), true);
  assert.equal(third.action.includes("SUUMO・LIFULL HOME'Sの掲載内容に、対応地域名・事情別の対応・日付つきの実績"), true);
  // 未掲載の at home だけ申込を勧める
  assert.equal(third.action.includes('at homeは未掲載なので掲載を申し込む'), true);
  assert.equal(/SUUMO[^。]*申し込/.test(third.action), false);
  // Google ビジネスプロフィールは gbp 候補が扱うので third には出さない
  assert.equal(third.action.includes(GBP), false);
});

test('candidatesFor: 不明なサイトは「確認のうえ」と書く', () => {
  const unknownOnly: ListingCheck = { ...listings, sites: [{ site: 'SUUMO', status: 'unknown' }] };
  const third = candidatesFor(target, '2026-09-03', unknownOnly).find((c) => c.key === 'third')!;
  assert.equal(third.title, '第三者サイトでの言及を増やす');
  assert.equal(third.action, 'SUUMOは掲載の有無を確認し、未掲載なら申し込み、掲載済みなら内容を更新する。');
});

test('candidatesFor: Google ビジネスプロフィールは掲載状況で登録／最新化を切り替える', () => {
  const gbp = (status: ListingCheck['sites'][number]['status']): string =>
    candidatesFor(target, '2026-09-03', { ...listings, sites: [{ site: GBP, status }] }).find((c) => c.key === 'gbp')!.title;
  assert.equal(gbp('not_listed'), 'Google ビジネスプロフィールに登録する');
  assert.equal(gbp('listed'), 'Google ビジネスプロフィールを最新化する');
  assert.equal(gbp('unknown'), 'Google ビジネスプロフィールを整備する');
});

test('listingsPromptLines: 未確認のときはそう書き、確認済みなら結果を列挙する', () => {
  assert.equal(listingsPromptLines(null)[0]!.includes('未確認'), true);
  const lines = listingsPromptLines(listings);
  assert.equal(lines[0]!.includes('Web 検索で確認した結果'), true);
  assert.equal(lines.some((l) => l.includes('SUUMO: 掲載あり')), true);
  assert.equal(lines.some((l) => l.includes('at home: 掲載なし')), true);
});

test('templateAdvice: 言及ゼロなら第三者サイトの提案が入り、掲載済みの根拠を添える', () => {
  const advice = templateAdvice(agg, listings);
  assert.equal(advice.suggestions.length, 3);
  assert.equal(advice.source, 'template');
  assert.equal(advice.costUsd, 0);
  const third = advice.suggestions.find((s) => s.title === '掲載済みサイトの情報を更新する');
  assert.ok(third, '掲載済みサイトの提案が無い');
  assert.equal(third.why.includes("SUUMO・LIFULL HOME'Sには掲載済みです。"), true);
  // 掲載状況が無いときは従来の文言
  const plain = templateAdvice(agg);
  assert.ok(plain.suggestions.find((s) => s.title === '第三者サイトでの言及を増やす'));
});
