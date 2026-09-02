import { GoogleGenAI } from '@google/genai';
import { domainOf } from '../lib/config.js';
import { mapPool } from '../lib/pool.js';
import type { Citation } from '../lib/types.js';
import type { SearchLocation } from './location.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

/**
 * Gemini API + Google Search グラウンディング。
 * groundingChunks[].web.uri はリダイレクト URL（vertexaisearch.cloud.google.com）で実 URL ではないので、
 * リダイレクト先を取得して実 URL に直す。取れなければ web.title（実質ホスト名）をドメインとして使う。
 */
export function createGeminiProvider(apiKey: string, model: string, location: SearchLocation): Provider {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 180_000 } });
  const retrievalConfig = {
    languageCode: 'ja-JP',
    ...(location.latitude !== undefined && location.longitude !== undefined
      ? { latLng: { latitude: location.latitude, longitude: location.longitude } }
      : {}),
  };

  return {
    engine: 'gemini',
    model,
    async ask(question: string): Promise<AskResult> {
      const res = await ai.models.generateContent({
        model,
        contents: question,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ googleSearch: {} }],
          toolConfig: { retrievalConfig },
        },
      });

      const candidate = res.candidates?.[0];
      if (!candidate) throw new Error(`Gemini returned no candidate (${res.promptFeedback?.blockReason ?? 'unknown'})`);
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw new Error(`Gemini finishReason ${candidate.finishReason}`);
      }
      const text =
        candidate.content?.parts
          ?.filter((p) => typeof p.text === 'string' && !p.thought)
          .map((p) => p.text)
          .join('') ?? '';
      if (!text.trim()) throw new Error('Gemini returned an empty answer');

      const gm = candidate.groundingMetadata;
      const chunks = (gm?.groundingChunks ?? []).map((c) => c.web).filter((w): w is NonNullable<typeof w> => Boolean(w?.uri));
      const resolved = await mapPool(chunks, 4, async (web) => ({ web, url: await resolveRedirect(web.uri!) }));

      const citations: Citation[] = [];
      const seen = new Set<string>();
      for (const { web, url } of resolved) {
        const domain = (url ? domainOf(url) : null) ?? hostFrom(web.domain) ?? hostFrom(web.title);
        if (!domain) continue; // ドメインが分からない引用は集計に使えないので raw にだけ残す
        const finalUrl = url ?? web.uri!;
        if (seen.has(finalUrl)) continue;
        seen.add(finalUrl);
        citations.push({ url: finalUrl, domain, title: web.title });
      }

      const u = res.usageMetadata;
      return {
        text,
        citations,
        usage: {
          // 検索で取得したコンテキスト（toolUsePromptTokenCount）は課金対象外なので入力に含めない（raw には残る）
          inputTokens: u?.promptTokenCount ?? 0,
          outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
          // Gemini 3 系は検索クエリ単位で課金される
          searches: gm?.webSearchQueries?.length ?? 0,
        },
        model: res.modelVersion ?? model,
        raw: res,
      };
    },
  };
}

/** vertexaisearch のリダイレクト URL から実 URL を取り出す。失敗したら null */
async function resolveRedirect(uri: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(uri).hostname;
  } catch {
    return null;
  }
  if (host !== REDIRECT_HOST) return uri;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(uri, { method: 'GET', redirect: 'manual', signal: controller.signal });
    await res.body?.cancel().catch(() => {});
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) return new URL(loc, uri).toString();
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "meguru-kaitori.jp" のようなホスト名なら www. を除いて返す。それ以外は null */
function hostFrom(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v.startsWith('www.') ? v.slice(4) : v;
}
