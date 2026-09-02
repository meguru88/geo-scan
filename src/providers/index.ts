import { apiKey, KEY_ENV } from '../lib/env.js';
import { modelFor } from '../lib/pricing.js';
import type { Engine, TargetConfig } from '../lib/types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { searchLocationFor } from './location.js';
import { createMockProvider } from './mock.js';
import { createOpenAIProvider } from './openai.js';
import { createPerplexityProvider } from './perplexity.js';
import type { Provider, ProviderContext } from './types.js';

export function createProvider(engine: Engine, target: TargetConfig, ctx: ProviderContext, mock: boolean): Provider {
  if (mock) return createMockProvider(engine, target, ctx);
  const key = apiKey(engine);
  if (!key) throw new Error(`${KEY_ENV[engine]} が設定されていません`);
  const model = modelFor(engine);
  const location = searchLocationFor(target);
  switch (engine) {
    case 'openai':
      return createOpenAIProvider(key, model, location);
    case 'gemini':
      return createGeminiProvider(key, model, location);
    case 'perplexity':
      return createPerplexityProvider(key, model, location);
    case 'anthropic':
      return createAnthropicProvider(key, model, location);
  }
}
