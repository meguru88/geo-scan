import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { crc32, safeZipPath, stripRoot, unzip, zipComment } from '../src/lib/zip.js';

/** テスト用の最小 ZIP ライター（リーダーが本物のバイト列を読めることを確かめるため） */
interface Src {
  path: string;
  data?: Buffer | string;
  /** 無圧縮（method 0）で入れる */
  store?: boolean;
  mode?: number;
  /** わざと壊れた CRC を書く */
  badCrc?: boolean;
}

function buildZip(files: readonly Src[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? '', 'utf8');
    const isDir = f.path.endsWith('/');
    const store = f.store === true || isDir;
    const comp = store ? raw : zlib.deflateRawSync(raw);
    const crc = f.badCrc ? (crc32(raw) ^ 0xff) >>> 0 : crc32(raw);
    const method = store ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((f.mode ?? (isDir ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const note = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, cd, eocd, note]);
}

test('crc32: 既知の値と一致する', () => {
  assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  assert.equal(crc32(Buffer.from('')), 0);
});

test('unzip: deflate と無圧縮の両方を展開し、ディレクトリは捨てる', () => {
  const zip = buildZip([
    { path: 'geo-scan-main/' },
    { path: 'geo-scan-main/README.md', data: '# geo-scan\n日本語も通る\n' },
    { path: 'geo-scan-main/src/' },
    { path: 'geo-scan-main/src/cli.ts', data: 'console.log(1)\n', store: true },
    { path: 'geo-scan-main/bin/run.sh', data: '#!/bin/sh\n', mode: 0o100755 },
  ]);
  const entries = unzip(zip);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['geo-scan-main/README.md', 'geo-scan-main/src/cli.ts', 'geo-scan-main/bin/run.sh'],
  );
  assert.equal(entries[0]!.data.toString('utf8'), '# geo-scan\n日本語も通る\n');
  assert.equal(entries[1]!.data.toString('utf8'), 'console.log(1)\n');
  assert.equal(entries[0]!.executable, false);
  assert.equal(entries[2]!.executable, true);
});

test('zipComment: GitHub の zip はコメントにコミット SHA が入っている', () => {
  const sha = '4f07587c0ffee0123456789abcdef0123456789a';
  assert.equal(zipComment(buildZip([{ path: 'a.txt', data: 'x' }], sha)), sha);
  assert.equal(zipComment(buildZip([{ path: 'a.txt', data: 'x' }])), '');
});

test('stripRoot: 共通の親ディレクトリを1段外す', () => {
  const entries = unzip(buildZip([
    { path: 'geo-scan-main/package.json', data: '{}' },
    { path: 'geo-scan-main/src/cli.ts', data: '1' },
  ]));
  assert.deepEqual(stripRoot(entries).map((e) => e.path), ['package.json', 'src/cli.ts']);
  // 共通の親が無ければそのまま
  const flat = unzip(buildZip([{ path: 'a/x.txt', data: '1' }, { path: 'b/y.txt', data: '2' }]));
  assert.deepEqual(stripRoot(flat).map((e) => e.path), ['a/x.txt', 'b/y.txt']);
  assert.deepEqual(stripRoot([]), []);
});

test('safeZipPath: 展開先の外に出るパスを弾く', () => {
  assert.equal(safeZipPath('./src/lib/zip.ts'), 'src/lib/zip.ts');
  assert.equal(safeZipPath('src\\lib\\zip.ts'), 'src/lib/zip.ts');
  assert.throws(() => safeZipPath('../evil.txt'), /不正なパス/);
  assert.throws(() => safeZipPath('src/../../evil.txt'), /不正なパス/);
  assert.throws(() => safeZipPath('/etc/passwd'), /不正なパス/);
  assert.throws(() => safeZipPath('C:/Windows/system32'), /不正なパス/);
});

test('unzip: 危険なパスを含む ZIP は展開しない', () => {
  assert.throws(() => unzip(buildZip([{ path: '../../.ssh/authorized_keys', data: 'x' }])), /不正なパス/);
});

test('unzip: 壊れた ZIP はエラーにする', () => {
  assert.throws(() => unzip(buildZip([{ path: 'a.txt', data: 'hello', badCrc: true }])), /壊れています/);
  assert.throws(() => unzip(Buffer.from('これは zip ではありません')), /ZIP として読めません/);
  assert.throws(() => unzip(Buffer.alloc(0)), /ZIP として読めません/);
  // 途中で切れた zip
  const zip = buildZip([{ path: 'a.txt', data: 'hello' }]);
  assert.throws(() => unzip(zip.subarray(0, zip.length - 10)), /ZIP として読めません/);
});
