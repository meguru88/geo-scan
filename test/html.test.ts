import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QuestionCell, QuestionRow } from '../src/lib/aggregate.js';
import { cleanReason, stableQuestionCount, toneOf } from '../src/lib/html.js';
import type { Mark } from '../src/lib/score.js';

/** mark と有効回答数だけ指定してセルを作る */
function cell(engine: string, mark: Mark, okRuns = 3): QuestionCell {
  return {
    engine,
    mark,
    measured: true,
    okRuns,
    mentionedRuns: mark === '○' ? okRuns : mark === '△' ? 1 : 0,
    citedRuns: 0,
    ranks: [],
  };
}

function row(no: number, cells: Record<string, QuestionCell>): QuestionRow {
  return { no, text: `Q${no}`, cells, mentionedAnywhere: Object.values(cells).some((c) => c.mentionedRuns > 0) };
}

test('toneOf: 0-29 赤 / 30-59 橙 / 60-100 緑', () => {
  assert.equal(toneOf(0), 'red');
  assert.equal(toneOf(29.9), 'red');
  assert.equal(toneOf(30), 'orange');
  assert.equal(toneOf(50), 'orange');
  assert.equal(toneOf(59.9), 'orange');
  assert.equal(toneOf(60), 'green');
  assert.equal(toneOf(100), 'green');
});

test('cleanReason: 引用記法や URL だけの抜粋は捨てる', () => {
  assert.equal(cleanReason('([komehyo.jp](https://komehyo.jp/?utm_source=openai))'), null);
  assert.equal(cleanReason('https://example.co.jp/osaka-kaitori'), null);
  assert.equal(cleanReason('([1](https://a.example.jp)) ([2](https://b.example.jp))'), null);
  assert.equal(cleanReason('（出典: example.com）'), null);
  assert.equal(cleanReason(''), null);
  assert.equal(cleanReason(undefined), null);
  assert.equal(cleanReason('   '), null);
  assert.equal(cleanReason('- 1. 2.'), null);
});

test('cleanReason: 文章はそのまま残し、混ざった引用記法だけを外す', () => {
  assert.equal(
    cleanReason('全国に多数の店舗を展開する大手です。'),
    '全国に多数の店舗を展開する大手です。',
  );
  assert.equal(
    cleanReason('査定料・出張料が無料です。 ([kaitori.example.jp](https://kaitori.example.jp/?utm_source=openai))'),
    '査定料・出張料が無料です。',
  );
  assert.equal(
    cleanReason('[買取大吉](https://daikichi.example.jp) は出張買取に対応しています'),
    '買取大吉 は出張買取に対応しています',
  );
});

test('stableQuestionCount: 全 AI が ○ の質問だけ数え、△ は含めない', () => {
  const engines = ['openai', 'gemini'];
  const rows = [
    row(1, { openai: cell('openai', '○'), gemini: cell('gemini', '○') }), // 数える
    row(2, { openai: cell('openai', '○'), gemini: cell('gemini', '△') }), // △ があるので数えない
    row(3, { openai: cell('openai', '△'), gemini: cell('gemini', '△') }),
    row(4, { openai: cell('openai', '×'), gemini: cell('gemini', '×') }),
    row(5, { openai: cell('openai', '○'), gemini: cell('gemini', '×') }),
  ];
  assert.equal(stableQuestionCount(rows, engines), 1);
});

test('stableQuestionCount: 有効な回答がない AI（未入力・全回エラー）は判定から外す', () => {
  const engines = ['openai', 'google_aio'];
  const unmeasured: QuestionCell = { engine: 'google_aio', mark: '－', measured: false, okRuns: 0, mentionedRuns: 0, citedRuns: 0, ranks: [] };
  const allErrored: QuestionCell = { engine: 'google_aio', mark: '－', measured: true, okRuns: 0, mentionedRuns: 0, citedRuns: 0, ranks: [] };
  assert.equal(stableQuestionCount([row(1, { openai: cell('openai', '○'), google_aio: unmeasured })], engines), 1);
  assert.equal(stableQuestionCount([row(1, { openai: cell('openai', '○'), google_aio: allErrored })], engines), 1);
  // どの AI にも有効な回答がなければ数えない
  assert.equal(stableQuestionCount([row(1, { openai: allErrored, google_aio: unmeasured })], engines), 0);
});

test('cleanReason: 長すぎる抜粋は 100 文字で切って … を付ける', () => {
  const long = 'あ'.repeat(150);
  const out = cleanReason(long);
  assert.equal(out?.length, 101);
  assert.equal(out?.endsWith('…'), true);
});
