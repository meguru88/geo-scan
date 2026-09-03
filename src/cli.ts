import { loadEnv } from './lib/env.js';
import { errorMessage } from './lib/redact.js';

const USAGE = `geo-scan — AI検索での「おすすめ」露出を計測する CLI

使い方:
  npm run add           -- --slug <slug> --url <URL> [--name "会社名"] [--industry "業種"] [--area "地域"]
                                  [--force] [--yes] [--runs 3] [--max-cost 1000] [--engines a,b]
  npm run batch         [-- [config/batch.csv] [--engines a,b] [--runs 3] [--max-cost 1000]
                                  [--max-total-cost 3000] [--force] [--yes]]
  npm run questions     -- <slug> [--force] [--mock]
  npm run scan          -- <slug> [--runs 3] [--engines openai,gemini,perplexity,anthropic]
                                  [--max-cost 500] [--date YYYY-MM-DD] [--yes] [--skip-extract]
                                  [--concurrency 2] [--mock] [--seed x]
  npm run extract       -- <slug> [--date YYYY-MM-DD] [--run N] [--force]
  npm run import-manual -- <slug> <csv>
  npm run report        -- <slug> [--date YYYY-MM-DD] [--run N] [--compare YYYY-MM-DD] [--max-cost 500]
                                  [--no-listings] [--recheck-listings] [--overwrite] [--no-pdf]
  npm run update        [-- --check] [--yes] [--branch main] [--zip <ダウンロード済みのzip>]
`;

/** コマンド名 → src/commands/ のファイル名 */
const COMMANDS: Record<string, string> = {
  add: 'add',
  batch: 'batch',
  questions: 'questions',
  scan: 'scan',
  extract: 'extract',
  'import-manual': 'importManual',
  report: 'report',
  update: 'update',
};

interface CommandModule {
  run(argv: string[]): Promise<void>;
}

async function main(): Promise<void> {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (rest.includes('--mock')) process.env.GEO_SCAN_MOCK = '1';
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  const file = COMMANDS[cmd];
  if (!file) {
    console.error(`不明なコマンド: ${cmd}\n`);
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const mod = (await import(`./commands/${file}.js`)) as CommandModule;
  await mod.run(rest);
}

main().catch((err: unknown) => {
  console.error(`エラー: ${errorMessage(err)}`);
  process.exit(1);
});
