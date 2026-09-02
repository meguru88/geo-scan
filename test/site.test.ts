import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { decodeEntities, detectCharset, extractHeadings, extractMeta, extractTitle, fetchSite, htmlToText, normalizeCharset } from '../src/lib/site.js';

test('normalizeCharset: 日本語サイトでよくある別名を寄せる', () => {
  assert.equal(normalizeCharset('UTF-8'), 'utf-8');
  assert.equal(normalizeCharset('utf8'), 'utf-8');
  assert.equal(normalizeCharset('Shift_JIS'), 'shift_jis');
  assert.equal(normalizeCharset('shift-jis'), 'shift_jis');
  assert.equal(normalizeCharset('x-sjis'), 'shift_jis');
  assert.equal(normalizeCharset('Windows-31J'), 'shift_jis');
  assert.equal(normalizeCharset('EUC-JP'), 'euc-jp');
  assert.equal(normalizeCharset(''), 'utf-8');
  assert.equal(normalizeCharset(null), 'utf-8');
});

test('detectCharset: ヘッダ優先、無ければ meta を見る', () => {
  assert.equal(detectCharset('text/html; charset=Shift_JIS', '<meta charset="utf-8">'), 'shift_jis');
  assert.equal(detectCharset('text/html', '<meta charset="EUC-JP">'), 'euc-jp');
  assert.equal(detectCharset(null, '<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">'), 'shift_jis');
  assert.equal(detectCharset('text/html', '<html><head><title>x</title>'), 'utf-8');
});

test('decodeEntities: 名前つき・数値の実体参照', () => {
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
  assert.equal(decodeEntities('&yen;1,000'), '¥1,000');
  assert.equal(decodeEntities('&#26085;&#26412;'), '日本');
  assert.equal(decodeEntities('&#x65E5;'), '日');
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
});

test('htmlToText: script/style を捨て、ブロック要素で改行する', () => {
  const html = `<html><head><style>.a{color:red}</style><script>var x = "<p>not text</p>";</script></head>
    <body><h1>ヘルパーステーションRoyG</h1><p>大阪市で訪問介護を行っています。</p><ul><li>居宅介護</li><li>重度訪問介護</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.equal(text.includes('not text'), false);
  assert.equal(text.includes('color:red'), false);
  assert.equal(text.includes('ヘルパーステーションRoyG'), true);
  assert.equal(text.includes('大阪市で訪問介護を行っています。'), true);
  // ブロック要素は改行で区切られる（連続する改行は最大2つにまとめる）
  assert.equal(/居宅介護\n\n?重度訪問介護/.test(text), true);
  assert.equal(/\n{3}/.test(text), false);
});

test('extractTitle / extractMeta / extractHeadings', () => {
  const html = `<html><head><title>  ヘルパーステーションRoyG | 大阪市の訪問介護  </title>
    <meta name="description" content="大阪市西成区の訪問介護・居宅介護">
    <meta property="og:description" content="og の説明">
    </head><body><h1>訪問介護</h1><h2>対応エリア</h2><h2>対応エリア</h2><h4>無視される</h4></body></html>`;
  assert.equal(extractTitle(html), 'ヘルパーステーションRoyG | 大阪市の訪問介護');
  assert.equal(extractMeta(html, 'description'), '大阪市西成区の訪問介護・居宅介護');
  assert.equal(extractMeta(html, 'og:description'), 'og の説明');
  assert.equal(extractMeta(html, 'keywords'), '');
  // h1〜h3 だけ・重複は除く
  assert.deepEqual(extractHeadings(html), ['訪問介護', '対応エリア']);
});

// --- fetchSite はローカルの HTTP サーバ相手に確認する ---
/** 「大阪市西成区」の Shift_JIS バイト列 */
const SJIS_OSAKA = Buffer.from('91e58de38e7390bc90ac8be6', 'hex');
let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/utf8') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>UTF-8 の店</title><meta name="description" content="説明文"></head><body><h1>見出し</h1><p>本文です。</p></body></html>');
      return;
    }
    if (url === '/sjis') {
      // 文字コードを meta にしか書いていない Shift_JIS のページ（古い日本語サイトによくある）
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        Buffer.concat([
          Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>', 'latin1'),
          SJIS_OSAKA,
          Buffer.from('</title></head><body><p>', 'latin1'),
          SJIS_OSAKA,
          Buffer.from('</p></body></html>', 'latin1'),
        ]),
      );
      return;
    }
    if (url === '/redirect') {
      res.writeHead(302, { Location: '/utf8' });
      res.end();
      return;
    }
    if (url === '/pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(Buffer.from('%PDF-1.4'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>not found</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('fetchSite: タイトル・説明・本文を取り出す', async () => {
  const page = await fetchSite(`${base}/utf8`);
  assert.equal(page.status, 200);
  assert.equal(page.charset, 'utf-8');
  assert.equal(page.title, 'UTF-8 の店');
  assert.equal(page.description, '説明文');
  assert.deepEqual(page.headings, ['見出し']);
  assert.equal(page.text.includes('本文です。'), true);
});

test('fetchSite: meta にしか書かれていない Shift_JIS を正しく読む', async () => {
  const page = await fetchSite(`${base}/sjis`);
  assert.equal(page.charset, 'shift_jis');
  assert.equal(page.title, '大阪市西成区');
  assert.equal(page.text.includes('大阪市西成区'), true);
});

test('fetchSite: リダイレクトを追い、最終 URL を返す', async () => {
  const page = await fetchSite(`${base}/redirect`);
  assert.equal(page.finalUrl.endsWith('/utf8'), true);
  assert.equal(page.title, 'UTF-8 の店');
});

test('fetchSite: HTML でなければエラー、404 でもエラー', async () => {
  await assert.rejects(() => fetchSite(`${base}/pdf`), /HTML ではない/);
  await assert.rejects(() => fetchSite(`${base}/missing`), /HTTP 404/);
});

test('fetchSite: URL の形式を検証する', async () => {
  await assert.rejects(() => fetchSite('not-a-url'), /URL が不正/);
  await assert.rejects(() => fetchSite('ftp://example.com/'), /http/);
});
