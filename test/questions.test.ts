import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasArea, setQuestionText } from '../src/commands/questions.js';
import type { QuestionSet, TargetConfig } from '../src/lib/types.js';

const target: TargetConfig = {
  slug: 'gh',
  name: 'グリーンハウジング',
  aliases: ['グリーンハウジング'],
  url: 'https://example.jp',
  industry: '不動産売買・買取',
  area: '大阪市東住吉区',
  areaAliases: ['東住吉区', '大阪市', '大阪'],
  competitors: [],
};

const qs: QuestionSet = {
  slug: 'gh',
  generatedAt: '2026-09-03T00:00:00.000Z',
  source: 'claude',
  questions: [
    { no: 1, text: '大阪市で家を売るならどこに頼む？', withArea: true },
    { no: 2, text: '無料査定を高めに出してくれる会社の選び方', withArea: false },
    { no: 3, text: '東住吉区 不動産 売却 おすすめ', withArea: true },
  ],
};

test('setQuestionText: 番号を保ったまま本文を差し替え、地域名入りかを判定し直す', () => {
  const out = setQuestionText(qs, 2, '  適正な査定額を出してくれる会社の見分け方 ', target);
  assert.deepEqual(out.questions[1], { no: 2, text: '適正な査定額を出してくれる会社の見分け方', withArea: false });
  // ほかの質問と元のオブジェクトは変えない
  assert.deepEqual(out.questions[0], qs.questions[0]);
  assert.equal(qs.questions[1]!.text, '無料査定を高めに出してくれる会社の選び方');
  // 地域名を入れれば withArea が true になる
  assert.equal(setQuestionText(qs, 2, '大阪で適正な査定額を出す会社の見分け方', target).questions[1]!.withArea, true);
});

test('setQuestionText: 無い番号・空文・長すぎる文は弾く', () => {
  assert.throws(() => setQuestionText(qs, 9, 'x', target), /質問番号 9 がありません/);
  assert.throws(() => setQuestionText(qs, 1.5, 'x', target), /質問番号/);
  assert.throws(() => setQuestionText(qs, 1, '   ', target), /空です/);
  assert.throws(() => setQuestionText(qs, 1, 'あ'.repeat(81), target), /長すぎます/);
});

test('hasArea: area と areaAliases のどれかを含めば地域名入り', () => {
  assert.equal(hasArea('東住吉区で不動産を売る', target), true);
  assert.equal(hasArea('不動産の売却の流れ', target), false);
});
