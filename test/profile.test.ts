import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCompetitors, normalizeProfile } from '../src/lib/profile.js';

const CTX = { hostname: 'roygbiv.stars.ne.jp' };

test('normalizeProfile: 社名とドメインを別名に必ず入れ、重複を除く', () => {
  const p = normalizeProfile(
    {
      name: 'ヘルパーステーションRoyG',
      aliases: ['ヘルパーステーションRoyG', 'RoyG', 'ロイジー', '株式会社RoyGBiv'],
      industry: '訪問介護',
      area: '大阪市西成区',
      areaAliases: ['西成区', '大阪市', '大阪'],
      confidence: 'high',
      notes: 'トップページに記載',
    },
    CTX,
  );
  assert.equal(p.name, 'ヘルパーステーションRoyG');
  assert.deepEqual(p.aliases, ['ヘルパーステーションRoyG', 'RoyG', 'ロイジー', '株式会社RoyGBiv', 'roygbiv.stars.ne.jp']);
  assert.deepEqual(p.areaAliases, ['西成区', '大阪市', '大阪']);
  assert.equal(p.confidence, 'high');
});

test('normalizeProfile: --name などの指定が推定より優先される', () => {
  const p = normalizeProfile(
    { name: 'サイトから読んだ名前', aliases: ['別名A'], industry: '推定業種', area: '推定地域', areaAliases: [] },
    { ...CTX, overrides: { name: 'ヘルパーステーションRoyG', industry: '訪問介護・居宅介護', area: '大阪市西成区' } },
  );
  assert.equal(p.name, 'ヘルパーステーションRoyG');
  assert.equal(p.industry, '訪問介護・居宅介護');
  assert.equal(p.area, '大阪市西成区');
  assert.equal(p.aliases[0], 'ヘルパーステーションRoyG');
});

test('normalizeProfile: 一般名詞・1文字の別名と、area と同じ areaAlias は落とす', () => {
  const p = normalizeProfile(
    {
      name: 'テスト介護',
      aliases: ['テスト介護', '株式会社', 'A', '  ', '専門店'],
      industry: '訪問介護',
      area: '大阪市西成区',
      areaAliases: ['大阪市西成区', '西成区', '西成区'],
    },
    CTX,
  );
  assert.deepEqual(p.aliases, ['テスト介護', 'roygbiv.stars.ne.jp']);
  assert.deepEqual(p.areaAliases, ['西成区']);
});

test('normalizeProfile: 名前が取れなければタイトル、それも無ければドメインを使う', () => {
  assert.equal(normalizeProfile({}, { ...CTX, title: 'ページタイトル' }).name, 'ページタイトル');
  assert.equal(normalizeProfile({}, CTX).name, 'roygbiv.stars.ne.jp');
  assert.equal(normalizeProfile({}, CTX).confidence, 'medium');
});

test('normalizeProfile: 業種の途中の括弧は残し、全体を囲む引用符だけ外す', () => {
  const p = normalizeProfile(
    { name: '「めぐる買取」', aliases: ['めぐる買取'], industry: '出張買取（貴金属・時計・ブランド品・着物）', area: '（大阪市東住吉区）', areaAliases: ['東住吉区'] },
    { hostname: 'meguru-kaitori.jp' },
  );
  assert.equal(p.name, 'めぐる買取');
  assert.equal(p.industry, '出張買取（貴金属・時計・ブランド品・着物）');
  assert.equal(p.area, '大阪市東住吉区');
});

test('normalizeCompetitors: 箇条書きの装飾を外し、自社と重複を除いて10件に切る', () => {
  const raw = [
    '1. おたからや',
    '・買取大吉',
    'おたからや',
    'ヘルパーステーションRoyG',
    '大手',
    'https://example.com',
    'A',
    'なんぼや',
    '福ちゃん',
    'KOMEHYO',
    'エコリング',
    'まねきや',
    'よろずや',
    'ゴールドミセス',
    '高く売れるドットコム',
    '13社目',
  ];
  const out = normalizeCompetitors(raw, ['ヘルパーステーションRoyG', 'RoyG']);
  assert.equal(out.length, 10);
  assert.equal(out[0], 'おたからや');
  assert.equal(out[1], '買取大吉');
  assert.equal(out.includes('ヘルパーステーションRoyG'), false);
  assert.equal(out.includes('大手'), false);
  assert.equal(out.includes('https://example.com'), false);
  assert.equal(out.includes('A'), false);
  // 重複は1件だけ
  assert.equal(out.filter((x) => x === 'おたからや').length, 1);
});

test('normalizeCompetitors: {name} の配列でも受け付け、配列でなければ空', () => {
  assert.deepEqual(normalizeCompetitors([{ name: 'おたからや' }, { name: '買取大吉' }]), ['おたからや', '買取大吉']);
  assert.deepEqual(normalizeCompetitors(undefined), []);
  assert.deepEqual(normalizeCompetitors('おたからや'), []);
});
