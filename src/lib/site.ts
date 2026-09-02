import { errorMessage } from './redact.js';

export interface SitePage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  /** 実際にデコードに使った文字コード */
  charset: string;
  title: string;
  description: string;
  headings: string[];
  /** タグ・スクリプトを除いた本文 */
  text: string;
}

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 8000;
const MAX_HEADINGS = 40;
const USER_AGENT = 'Mozilla/5.0 (compatible; geo-scan/0.1; +https://github.com/meguru88/geo-scan)';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  yen: '¥',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '・',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 日本語サイトでよく使われる別名を正規の文字コード名に寄せる */
const CHARSET_ALIASES: Record<string, string> = {
  utf8: 'utf-8',
  sjis: 'shift_jis',
  'shift-jis': 'shift_jis',
  'x-sjis': 'shift_jis',
  ms_kanji: 'shift_jis',
  'windows-31j': 'shift_jis',
  cp932: 'shift_jis',
  eucjp: 'euc-jp',
  'x-euc-jp': 'euc-jp',
};

export function normalizeCharset(raw: string | null | undefined): string {
  const c = (raw ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!c) return 'utf-8';
  return CHARSET_ALIASES[c] ?? c;
}

/** Content-Type ヘッダ →（無ければ）HTML 先頭の meta から文字コードを決める */
export function detectCharset(contentType: string | null | undefined, rawHead: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType ?? '')?.[1];
  if (fromHeader) return normalizeCharset(fromHeader);
  const fromMeta = /<meta[^>]*?charset\s*=\s*["']?([\w:.-]+)/i.exec(rawHead)?.[1];
  if (fromMeta) return normalizeCharset(fromMeta);
  return 'utf-8';
}

const BLOCK_TAGS =
  'address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';
const BLOCK_RE = new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi');

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>/gi, ' ')
    .replace(BLOCK_RE, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() : '';
}

/** <meta name="..."> と <meta property="..."> の両方を見る（属性の順序も問わない） */
export function extractMeta(html: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const named = new RegExp(`(?:name|property)\\s*=\\s*["']?${escaped}["']?[\\s>]`, 'i').test(tag);
    if (!named) continue;
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return decodeEntities(value).replace(/\s+/g, ' ').trim();
  }
  return '';
}

export function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const re = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_HEADINGS) {
    const text = htmlToText(m[2]!).replace(/\s+/g, ' ').trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function decodeBuffer(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    // Node が知らない文字コード名なら UTF-8 として読む（文字化けしても後続の推定は続行できる）
    return buf.toString('utf8');
  }
}

export function parsePage(html: string, meta: { requestedUrl: string; finalUrl: string; status: number; charset: string }): SitePage {
  const text = htmlToText(html);
  return {
    ...meta,
    title: extractTitle(html),
    description: extractMeta(html, 'description') || extractMeta(html, 'og:description'),
    headings: extractHeadings(html),
    text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
  };
}

/** サイトを1ページ取得して、社名・業種・地域の推定に使えるテキストにする */
export async function fetchSite(url: string): Promise<SitePage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL が不正です: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http:// または https:// の URL を指定してください: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`サイトを取得できませんでした（${parsed.hostname}）: ${errorMessage(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`サイトの取得に失敗しました: HTTP ${res.status} ${parsed.toString()}`);

  const contentType = res.headers.get('content-type');
  const raw = Buffer.from(await res.arrayBuffer());
  const buf = raw.length > MAX_BYTES ? raw.subarray(0, MAX_BYTES) : raw;
  if (buf.length === 0) throw new Error(`サイトの中身が空でした: ${parsed.toString()}`);
  if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
    throw new Error(`HTML ではないため解析できません（Content-Type: ${contentType}）: ${parsed.toString()}`);
  }

  const charset = detectCharset(contentType, buf.subarray(0, 4096).toString('latin1'));
  const html = decodeBuffer(buf, charset);
  const page = parsePage(html, { requestedUrl: url, finalUrl: res.url || parsed.toString(), status: res.status, charset });
  if (!page.title && !page.text) throw new Error(`本文を取り出せませんでした: ${parsed.toString()}`);
  return page;
}
