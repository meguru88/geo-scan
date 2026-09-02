import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markOf, rankPoints, scoreOf } from '../src/lib/score.js';
import type { Extraction } from '../src/lib/types.js';

function ex(p: Partial<Extraction>): Extraction {
  return {
    id: 'x',
    engine: 'openai',
    questionNo: 1,
    runIndex: 1,
    status: 'ok',
    source: 'scan',
    mentioned: false,
    rank: null,
    citedOwnSite: false,
    competitorsMentioned: [],
    businesses: [],
    citedDomains: [],
    method: 'regex',
    extractedAt: '',
    ...p,
  };
}

test('rankPoints: 1位30・2位20・3位12・4位以下5', () => {
  assert.equal(rankPoints(1), 30);
  assert.equal(rankPoints(2), 20);
  assert.equal(rankPoints(3), 12);
  assert.equal(rankPoints(4), 5);
  assert.equal(rankPoints(9), 5);
  assert.equal(rankPoints(null), 5);
});

test('scoreOf: 全回1位で自社引用ありなら100点', () => {
  const s = scoreOf([1, 2, 3].map(() => ex({ mentioned: true, rank: 1, citedOwnSite: true })));
  assert.equal(s.total, 100);
  assert.equal(s.mentionScore, 50);
  assert.equal(s.rankScore, 30);
  assert.equal(s.citeScore, 20);
});

test('scoreOf: 言及率は ok な回答のみで計算し、error は除外', () => {
  const s = scoreOf([
    ex({ mentioned: true, rank: 2 }),
    ex({ mentioned: false }),
    ex({ status: 'error' }),
  ]);
  assert.equal(s.answers, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.mentionRate, 0.5);
  assert.equal(s.mentionScore, 25);
  assert.equal(s.rankScore, 20);
  assert.equal(s.citeScore, 0);
  assert.equal(s.total, 45);
});

test('scoreOf: 回答なしなら 0 点', () => {
  const s = scoreOf([ex({ status: 'error' })]);
  assert.equal(s.total, 0);
  assert.equal(s.avgRank, null);
});

test('markOf: ○△×－', () => {
  assert.equal(markOf([ex({ mentioned: true }), ex({ mentioned: true }), ex({ mentioned: true })]).mark, '○');
  assert.equal(markOf([ex({ mentioned: true }), ex({ mentioned: false }), ex({ mentioned: true })]).mark, '△');
  assert.equal(markOf([ex({ mentioned: false }), ex({ mentioned: false })]).mark, '×');
  assert.equal(markOf([ex({ status: 'error' })]).mark, '－');
  assert.equal(markOf([]).mark, '－');
});
