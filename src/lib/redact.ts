import { KEY_ENV } from './env.js';

/** APIキーらしき文字列をログ・保存物から除去する */
const KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /pplx-[A-Za-z0-9]{8,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
];

export function redact(input: string): string {
  let out = input;
  for (const p of KEY_PATTERNS) out = out.replace(p, '[REDACTED]');
  for (const envName of Object.values(KEY_ENV)) {
    const v = process.env[envName];
    if (v && v.length >= 8) out = out.split(v).join('[REDACTED]');
  }
  return out;
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
