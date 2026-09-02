import zlib from 'node:zlib';

/**
 * 依存なしの最小 ZIP リーダー。
 * GitHub の「ソースコード zip」（codeload の archive）を展開するために使う。
 * unzip コマンドや外部パッケージが無い環境でも動くよう Node の zlib だけで実装している。
 */
export interface ZipEntry {
  /** アーカイブ内のパス（/ 区切り。ディレクトリは含まない） */
  path: string;
  data: Buffer;
  /** Unix の実行ビットが立っているか */
  executable: boolean;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** 32bit に収まらない値のときに入る印。ZIP64 の拡張フィールドを読む必要がある */
const ZIP64_MARK = 0xffffffff;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

let table: Int32Array | null = null;

/** CRC-32 (IEEE)。展開したデータが壊れていないかの確認に使う */
export function crc32(buf: Buffer): number {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * zip-slip 対策。展開先の外に出るパスや絶対パスを弾き、`./` などを取り除いた相対パスを返す。
 * 更新で任意のファイルを書き換えられないようにするため、ここで必ず通す。
 */
export function safeZipPath(name: string): string {
  const raw = name.replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) {
    throw new Error(`ZIP に不正なパスが含まれています: ${name}`);
  }
  const parts = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) throw new Error(`ZIP に不正なパスが含まれています: ${name}`);
  const p = parts.join('/');
  if (!p) throw new Error(`ZIP に不正なパスが含まれています: ${name}`);
  return p;
}

/** End of Central Directory の位置。コメント長が実際の残りバイト数と合うものを末尾から探す */
function findEocd(buf: Buffer): number {
  if (buf.length < EOCD_SIZE) throw new Error('ZIP として読めません（ファイルが小さすぎます）');
  const min = Math.max(0, buf.length - (MAX_COMMENT + EOCD_SIZE));
  for (let i = buf.length - EOCD_SIZE; i >= min; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    if (buf.readUInt16LE(i + 20) === buf.length - i - EOCD_SIZE) return i;
  }
  throw new Error('ZIP として読めません（End of Central Directory が見つかりません）');
}

/** アーカイブ末尾のコメント。GitHub の zip にはコミットの SHA が入っている */
export function zipComment(buf: Buffer): string {
  const eocd = findEocd(buf);
  const len = buf.readUInt16LE(eocd + 20);
  return buf.toString('utf8', eocd + 22, eocd + 22 + len).trim();
}

/** ZIP を展開してファイル一覧を返す（ディレクトリのエントリは捨てる） */
export function unzip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK) {
    throw new Error('ZIP64 形式には対応していません（ファイル数が多すぎます）');
  }
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP が壊れています（中央ディレクトリが範囲外）');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('ZIP が壊れています（エントリの見出しが不正）');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) throw new Error('ZIP が壊れています（中央ディレクトリの長さが合いません）');

    if (name.endsWith('/')) continue; // ディレクトリ
    if (flags & 0x1) throw new Error('暗号化された ZIP は展開できません');
    if (compSize === ZIP64_MARK || rawSize === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw new Error(`ZIP64 形式には対応していません: ${name}`);
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
      throw new Error(`ZIP が壊れています（${name} の位置が不正）`);
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const end = start + compSize;
    if (end > buf.length) throw new Error(`ZIP が壊れています（${name} の中身が範囲外）`);
    const chunk = buf.subarray(start, end);

    let data: Buffer;
    if (method === 0) data = Buffer.from(chunk);
    else if (method === 8) data = zlib.inflateRawSync(chunk);
    else throw new Error(`対応していない圧縮方式です (${method}): ${name}`);

    if (data.length !== rawSize || crc32(data) !== crc) throw new Error(`ZIP の中身が壊れています: ${name}`);
    // 外部属性の上位 16bit が Unix のモード
    entries.push({ path: safeZipPath(name), data, executable: ((attrs >>> 16) & 0o111) !== 0 });
  }
  return entries;
}

/**
 * GitHub の zip は全体が `<repo>-<branch>/` に入っているので、その 1 段を外す。
 * 共通の親が無ければそのまま返す。
 */
export function stripRoot(entries: readonly ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) return [];
  const roots = new Set(entries.map((e) => e.path.split('/')[0]!));
  if (roots.size !== 1) return [...entries];
  const prefix = `${[...roots][0]!}/`;
  if (!entries.every((e) => e.path.startsWith(prefix))) return [...entries];
  return entries.map((e) => ({ ...e, path: e.path.slice(prefix.length) }));
}
