import fs from 'node:fs';
import type { Browser, LaunchOptions } from 'puppeteer';
import { KEY_ENV } from './env.js';
import { errorMessage } from './redact.js';

/** 動的 import した puppeteer のうち使う部分だけ（バージョン差で型がずれるため緩くしておく） */
interface PuppeteerLike {
  launch(options?: LaunchOptions): Promise<Browser>;
}

/** Chrome に渡す環境変数。API キーは渡さない */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const secret = new Set(Object.values(KEY_ENV));
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || secret.has(k) || /(_API_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/** root で動かすコンテナ等では sandbox が使えないので、そのときだけ無効化する */
function launchArgs(): string[] {
  const args = ['--disable-dev-shm-usage'];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot || process.env.GEO_SCAN_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  return args;
}

/**
 * HTML を puppeteer で A4 PDF にする。失敗しても例外にせず false を返す（HTML はブラウザ印刷で PDF 化できる）。
 * 古い PDF が残らないよう先に消し、成功したときだけ書き出す。Chrome の場所は PUPPETEER_EXECUTABLE_PATH で上書きできる。
 */
export async function htmlToPdf(html: string, outFile: string): Promise<boolean> {
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  let puppeteer: PuppeteerLike;
  try {
    puppeteer = (await import('puppeteer')) as unknown as PuppeteerLike;
  } catch (err) {
    console.warn(`puppeteer を読み込めませんでした（${errorMessage(err).slice(0, 120)}）。report.html をブラウザで開いて「印刷 → PDF に保存」してください`);
    return false;
  }
  const tmpFile = `${outFile}.tmp`;
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
      args: launchArgs(),
      env: browserEnv(),
    });
    try {
      const page = await browser.newPage();
      // レポートは静的 HTML なので JS も外部リソースも不要
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (req) => (req.url().startsWith('data:') || req.url().startsWith('about:') ? req.continue() : req.abort()));
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('print');
      await page.pdf({
        path: tmpFile,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
      });
    } finally {
      await browser.close();
    }
    fs.renameSync(tmpFile, outFile);
    return true;
  } catch (err) {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    console.warn(`PDF 変換に失敗しました（${errorMessage(err).slice(0, 200)}）。`);
    console.warn('Chrome が見つからない場合は `npx puppeteer browsers install chrome` を実行するか、PUPPETEER_EXECUTABLE_PATH を設定してください。report.html をブラウザで印刷しても PDF にできます');
    return false;
  }
}
