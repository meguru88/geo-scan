import readline from 'node:readline/promises';

/**
 * y/N を尋ねる。cron や CI など対話できない環境では、黙って続行せずエラーで止める
 * （実行すると課金が発生するコマンドで使うため）。
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error('対話できない環境（cron / CI / パイプ）です。内容を確認済みなら --yes を付けて実行してください');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}
