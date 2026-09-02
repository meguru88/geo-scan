import { GoogleGenAI } from '@google/genai';
import type { Citation } from '../lib/types.js';
import { SYSTEM_PROMPT, type AskResult, type Provider } from './types.js';

/** 大阪市の座標（検索のロケールヒント） */
const OSAKA = { latitude: 34.6937, longitude: 135.5023 };

/**
 * Gemini API + Google Search グラウンディング。
 * groundingChunks[].web.uri はリダイレクト URL（vertexaisearch.cloud.google.com）で実 URL ではなく、
 * web.title が実質ホスト名なのでそれをドメインとして使う（web.domain は Gemini API では非対応）。
 */
export function createGeminiProvider(apiKey: string, model: string): Provider {
  const ai = new GoogleGenAI({ apiKey });

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
          toolConfig: { retrievalConfig: { languageCode: 'ja-JP', latLng: OSAKA } },
        },
      });

      const candidate = res.candidates?.[0];
      const text =
        candidate?.content?.parts
          ?.filter((p) => typeof p.text === 'string' && !p.thought)
          .map((p) => p.text)
          .join('') ?? '';

      const gm = candidate?.groundingMetadata;
      const citations: Citation[] = [];
      const seen = new Set<string>();
      for (const chunk of gm?.groundingChunks ?? []) {
        const web = chunk.web;
        if (!web?.uri) continue;
        const domain = hostFrom(web.domain) ?? hostFrom(web.title);
        if (!domain) continue; // ドメインが分からない引用は集計に使えないので raw にだけ残す
        const key = `${domain}|${web.uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ url: web.uri, domain, title: web.title });
      }

      const u = res.usageMetadata;
      return {
        text,
        citations,
        usage: {
          inputTokens: (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0),
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

/** "meguru-kaitori.jp" のようなホスト名なら www. を除いて返す。それ以外は null */
function hostFrom(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return v.startsWith('www.') ? v.slice(4) : v;
}
