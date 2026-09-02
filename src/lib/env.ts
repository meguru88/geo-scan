import fs from 'node:fs';
import path from 'node:path';
import type { Engine } from './types.js';

let loaded = false;

/** .env をプロセス環境に読み込む（既に設定済みの変数は上書きしない）。依存を増やさないための最小実装 */
export function loadEnv(root: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = (m[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const KEY_ENV: Record<Engine, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export function apiKey(engine: Engine): string | undefined {
  const v = process.env[KEY_ENV[engine]];
  return v && v.trim() ? v.trim() : undefined;
}

export function hasAnthropicKey(): boolean {
  return apiKey('anthropic') !== undefined;
}

/** GEO_SCAN_MOCK=1 または --mock でモック動作 */
export function isMock(): boolean {
  return process.env.GEO_SCAN_MOCK === '1';
}

export function usdJpyRate(): number {
  const v = Number(process.env.USD_JPY);
  return Number.isFinite(v) && v > 0 ? v : 150;
}
