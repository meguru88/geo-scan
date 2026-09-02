import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexOfName, namesMatch, normalize, normalizeWithMap, regexExtract } from '../src/lib/extract.js';
import type { TargetConfig } from '../src/lib/types.js';

const target: TargetConfig = {
  slug: 'meguru',
  name: 'めぐる買取',
  aliases: ['めぐる買取', 'MEGURU', '株式会社RoyGBiv', 'meguru-kaitori.jp'],
  url: 'https://meguru-kaitori.jp',
  industry: '出張買取',
  area: '大阪市東住吉区',
  areaAliases: ['東住吉区', '大阪市', '大阪'],
  competitors: ['おたからや', '買取大吉', 'なんぼや'],
};

test('normalize: 全角英数・大文字・空白の揺れを吸収', () => {
  assert.equal(normalize('ＭＥＧＵＲＵ 買取'), 'meguru買取');
  assert.equal(normalize('Meguru'), 'meguru');
});

test('normalizeWithMap: NFKC で長さが変わる文字があっても元の位置に戻せる', () => {
  const text = '㈱RoyGBiv は 東住吉区。';
  const { norm, map } = normalizeWithMap(text);
  assert.equal(norm, '(株)roygbivは東住吉区。');
  const i = norm.indexOf('東住吉');
  assert.equal(text[map[i]!], '東');
});

test('namesMatch: 抽出名が設定名を含む場合だけ一致。断片や逆方向の包含は不一致', () => {
  assert.equal(namesMatch('買取大吉 難波店', '買取大吉'), true);
  assert.equal(namesMatch('ＫＯＭＥＨＹＯ', 'KOMEHYO'), true);
  assert.equal(namesMatch('大吉', '買取大吉'), false);
  assert.equal(namesMatch('おたから', 'おたからや'), false);
  assert.equal(namesMatch('株式会社', '株式会社RoyGBiv'), false);
  assert.equal(namesMatch('なんぼや', 'おたからや'), false);
});

test('indexOfName: 英数字の別名は単語境界で判定する', () => {
  const norm = normalize('Home Guru という海外サイトによると、MEGURU が人気です。');
  assert.equal(indexOfName(norm, 'MEGURU') > normalize('Home Guru という海外サイトによると、').length - 1, true);
  assert.equal(indexOfName(normalize('homeguru only'), 'MEGURU'), -1);
  assert.equal(indexOfName(normalize('https://meguru-kaitori.jp/price'), 'meguru-kaitori.jp') >= 0, true);
});

test('regexExtract: 英数字別名が他の単語の一部なら言及なし', () => {
  const r = regexExtract({ text: 'Home Guru という海外サイトによると、おたからやが人気です。', citations: [] }, target);
  assert.equal(r.mentioned, false);
});

test('regexExtract: 別名で言及を検出し、出現順に順位を付ける', () => {
  const text = '大阪なら以下がおすすめです。\n\n1. **おたからや**\n全国展開の大手です。\n\n2. **MEGURU**\n東住吉区の地域密着店です。\n\n3. 買取大吉：出張無料。';
  const r = regexExtract({ text, citations: [{ url: 'https://www.meguru-kaitori.jp/price', domain: 'meguru-kaitori.jp' }] }, target);
  assert.equal(r.mentioned, true);
  assert.equal(r.citedOwnSite, true);
  assert.deepEqual(r.businesses.map((b) => b.name), ['おたからや', 'めぐる買取', '買取大吉']);
  assert.equal(r.businesses[1]?.isTarget, true);
  assert.deepEqual(r.competitorsMentioned, ['おたからや', '買取大吉']);
  assert.deepEqual(r.citedDomains, ['meguru-kaitori.jp']);
});

test('regexExtract: 見出し行だけの名前は次の文を理由にする', () => {
  const text = '1. **おたからや**\n全国展開の大手で、出張買取にも対応しています。\n2. 買取大吉：出張無料で少量でも相談できます。';
  const r = regexExtract({ text, citations: [] }, target);
  assert.equal(r.businesses[0]?.reason, '全国展開の大手で、出張買取にも対応しています。');
  assert.equal(r.businesses[1]?.reason, '買取大吉：出張無料で少量でも相談できます。');
});

test('regexExtract: 言及なし・自社引用なし', () => {
  const r = regexExtract({ text: 'なんぼやが有名です。', citations: [{ url: 'https://example.com/a', domain: 'example.com' }] }, target);
  assert.equal(r.mentioned, false);
  assert.equal(r.citedOwnSite, false);
  assert.deepEqual(r.competitorsMentioned, ['なんぼや']);
});

test('regexExtract: サブドメインも自社引用とみなす', () => {
  const r = regexExtract({ text: '', citations: [{ url: 'https://blog.meguru-kaitori.jp/x', domain: 'blog.meguru-kaitori.jp' }] }, target);
  assert.equal(r.citedOwnSite, true);
});
