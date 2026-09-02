import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ownDomain } from '../lib/config.js';
import { sleep } from '../lib/pool.js';
import type { Citation, Engine, TargetConfig } from '../lib/types.js';
import type { AskMeta, AskResult, Provider, ProviderContext } from './types.js';

interface PoolBusiness {
  name: string;
  domain: string;
  blurbs: string[];
}

interface MockPool {
  intros: string[];
  outros: string[];
  targetBlurbs: string[];
  keywordBias: Record<string, number>;
  thirdParty: { domain: string; title: string }[];
  businesses: PoolBusiness[];
}

/** エンジンごとに自社が出る基礎確率（モック用） */
const ENGINE_BIAS: Record<Engine, number> = {
  openai: 0.45,
  gemini: 0.3,
  perplexity: 0.55,
  anthropic: 0.4,
};

function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  const v = arr[Math.floor(rng() * arr.length)];
  if (v === undefined) throw new Error('mock pool is empty');
  return v;
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

let poolCache: MockPool | null = null;
function loadPool(): MockPool {
  if (poolCache) return poolCache;
  const file = path.join(ROOT, 'fixtures', 'mock-pool.json');
  poolCache = JSON.parse(fs.readFileSync(file, 'utf8')) as MockPool;
  return poolCache;
}

/**
 * API を呼ばずに fixtures から決定論的な回答を合成するプロバイダ。
 * seed・日付・エンジン・質問番号・回数で結果が変わるので、3回平均や --compare の確認に使える。
 * GEO_SCAN_MOCK_FAIL_RATE=0.2 のように指定すると、その確率で失敗してリトライ／error 記録の経路を試せる。
 */
export function createMockProvider(engine: Engine, target: TargetConfig, ctx: ProviderContext): Provider {
  const pool = loadPool();
  const own = ownDomain(target);
  const failRate = Number(process.env.GEO_SCAN_MOCK_FAIL_RATE ?? '0') || 0;
  let calls = 0;

  return {
    engine,
    model: `mock-${engine}`,
    async ask(question: string, meta: AskMeta): Promise<AskResult> {
      const attempt = ++calls;
      const rng = mulberry32(hash32(`${ctx.seed}|${ctx.date}|${engine}|${meta.questionNo}|${meta.runIndex}`));
      await sleep(30 + Math.floor(rng() * 120));

      if (failRate > 0) {
        const failRng = mulberry32(hash32(`fail|${ctx.seed}|${engine}|${meta.questionNo}|${meta.runIndex}|${attempt}`));
        if (failRng() < failRate) throw new Error(`mock failure (simulated, attempt ${attempt})`);
      }

      let p = ENGINE_BIAS[engine];
      for (const [kw, delta] of Object.entries(pool.keywordBias)) if (question.includes(kw)) p += delta;
      const includeTarget = rng() < Math.min(0.95, Math.max(0.05, p));

      const n = 3 + Math.floor(rng() * 3);
      const items = shuffle(pool.businesses, rng)
        .slice(0, n)
        .map((b) => ({ name: b.name, blurb: pick(b.blurbs, rng), domain: b.domain, isTarget: false }));
      if (includeTarget) {
        const pos = Math.floor(rng() * (items.length + 1));
        items.splice(pos, 0, { name: target.name, blurb: pick(pool.targetBlurbs, rng), domain: own, isTarget: true });
      }

      const intro = pick(pool.intros, rng).replace('{q}', question);
      const body = items.map((it, i) => `${i + 1}. **${it.name}**\n${it.blurb}`).join('\n\n');
      const text = `${intro}\n\n${body}\n\n${pick(pool.outros, rng)}`;

      const citations: Citation[] = [];
      for (const it of items) {
        const cite = it.isTarget ? rng() < 0.6 : rng() < 0.7;
        if (cite) citations.push({ url: `https://${it.domain}/`, domain: it.domain, title: it.name });
      }
      const extra = 1 + Math.floor(rng() * 2);
      for (const tp of shuffle(pool.thirdParty, rng).slice(0, extra)) {
        citations.push({ url: `https://${tp.domain}/osaka/kaitori-${meta.questionNo}`, domain: tp.domain, title: tp.title });
      }

      return {
        text,
        citations,
        usage: {
          inputTokens: 2000 + Math.floor(rng() * 1500),
          outputTokens: Math.round(text.length * 0.9),
          searches: 1 + Math.floor(rng() * 2),
        },
        model: `mock-${engine}`,
        raw: { mock: true, includeTarget, seed: ctx.seed },
      };
    },
  };
}
