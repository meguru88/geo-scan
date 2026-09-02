import { KEY_ENV } from './env.js';

/** APIキーらしき文字列をログ・保存物から除去する */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /pplx-[A-Za-z0-9_-]{8,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/g,
  /((?:x-api-key|x-goog-api-key|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
];

export function redact(input: string): string {
  let out = input;
  // 先に .env の値そのもの（長いものから）を消し、そのあと形式一致で拾う
  const values = Object.values(KEY_ENV)
    .map((name) => process.env[name])
    .filter((v): v is string => Boolean(v && v.length >= 8))
    .sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join('[REDACTED]');
  for (const p of KEY_PATTERNS) out = out.replace(p, (m, prefix?: string) => (typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]'));
  return out;
}

/** JSON にして保存する前に、値の中のキーを一括で伏せる */
export function redactDeep<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}

/** unknown なエラーから安全なメッセージを作る */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    const prefix = typeof status === 'number' ? `HTTP ${status}: ` : '';
    const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
    return redact(`${prefix}${name}${err.message}`).slice(0, 2000);
  }
  return redact(String(err)).slice(0, 2000);
}
