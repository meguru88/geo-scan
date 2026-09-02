import fs from 'node:fs';
import { flagBool, parseArgs } from '../lib/args.js';
import { askJson, writerModel } from '../lib/claude.js';
import { loadTarget, questionsPath, saveQuestions } from '../lib/config.js';
import { hasAnthropicKey, isMock } from '../lib/env.js';
import { rel } from '../lib/runs.js';
import type { Question, QuestionSet, TargetConfig } from '../lib/types.js';

const QUESTION_COUNT = 10;

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          withArea: { type: 'boolean' },
          item: { type: 'string' },
        },
        required: ['text', 'withArea', 'item'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

interface Generated {
  questions: { text: string; withArea: boolean; item: string }[];
}

export function hasArea(text: string, target: TargetConfig): boolean {
  return [target.area, ...target.areaAliases].some((a) => a && text.includes(a));
}

async function generateWithClaude(target: TargetConfig): Promise<{ questions: Question[]; model: string }> {
  const system =
    'あなたは中小企業のWeb集客を支援するコンサルタントです。' +
    '一般の消費者が ChatGPT や Gemini などの AI 検索に実際に打ち込みそうな、自然な日本語の質問を作ります。' +
    '特定の会社名は質問に入れません。';
  const user = [
    `対象企業: ${target.name}`,
    `業種: ${target.industry}`,
    `地域: ${target.area}（表記ゆれ: ${target.areaAliases.join('、')}）`,
    '',
    `この企業の見込み客が AI に聞きそうな質問を ${QUESTION_COUNT} 個作ってください。`,
    `- 地域名（${target.area} または ${target.areaAliases.join('・')}）を含む質問を 5 個、含まない質問を 5 個`,
    '- 取扱品目・用途（例: 貴金属、時計、ブランド品、着物、遺品整理、実家の片付け）が偏らないよう散らす',
    '- 「おすすめは？」「信頼できるのは？」「高く買ってくれるのは？」など、業者名を答えたくなる聞き方にする',
    '- 検索窓に打つような短い体言止め（例:「東住吉区 出張買取 おすすめ」）も 2〜3 個混ぜる',
    '- 各質問は 40 文字以内',
    '',
    'JSON で {"questions":[{"text":"...","withArea":true,"item":"貴金属"}, ...]} の形で返してください。',
  ].join('\n');

  const model = writerModel();
  const res = await askJson<Generated>({ model, system, user, schema: SCHEMA, maxTokens: 4096, effort: 'medium' });
  const list = (res.value.questions ?? []).filter((q) => q && typeof q.text === 'string' && q.text.trim());
  if (list.length < QUESTION_COUNT) throw new Error(`Claude が返した質問が ${list.length} 個しかありません（${QUESTION_COUNT} 個必要）`);
  const questions = list.slice(0, QUESTION_COUNT).map((q, i) => ({
    no: i + 1,
    text: q.text.trim(),
    withArea: hasArea(q.text, target),
  }));
  const withArea = questions.filter((q) => q.withArea).length;
  if (withArea !== QUESTION_COUNT / 2) {
    console.warn(`注意: 地域名入りが ${withArea} 個です（目標 ${QUESTION_COUNT / 2}）。必要なら手で編集してください`);
  }
  return { questions, model: res.model };
}

function generateMock(target: TargetConfig): Question[] {
  const items = ['貴金属', '腕時計', 'ブランドバッグ', '着物', '遺品整理'];
  const withArea = items.map((it) => `${target.area}で${it}の${target.industry.split('（')[0]}、おすすめの業者は？`);
  const without = items.map((it) => `${it}を高く買ってくれる信頼できる業者は？`);
  return [...withArea, ...without].map((text, i) => ({ no: i + 1, text, withArea: i < items.length }));
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const slug = args.positionals[0];
  if (!slug) throw new Error('使い方: npm run questions -- <slug> [--force]');
  const target = loadTarget(slug);
  const file = questionsPath(slug);
  const force = flagBool(args, 'force');

  if (fs.existsSync(file) && !force) {
    console.log(`${rel(file)} は既にあります。上書きするには --force を付けてください。`);
    return;
  }

  let qs: QuestionSet;
  if (isMock()) {
    qs = { slug, generatedAt: new Date().toISOString(), source: 'mock', questions: generateMock(target) };
  } else {
    if (!hasAnthropicKey()) throw new Error('ANTHROPIC_API_KEY が設定されていません（.env を確認してください）');
    console.log(`Claude (${writerModel()}) で質問を生成しています…`);
    const g = await generateWithClaude(target);
    qs = { slug, generatedAt: new Date().toISOString(), source: 'claude', model: g.model, questions: g.questions };
  }

  saveQuestions(qs);
  console.log(`保存しました: ${rel(file)}`);
  for (const q of qs.questions) console.log(`  ${String(q.no).padStart(2)}. ${q.text}${q.withArea ? '' : '　(地域名なし)'}`);
}
