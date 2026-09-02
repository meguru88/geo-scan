import type { Browser, LaunchOptions } from 'puppeteer';
import { errorMessage } from './redact.js';

/** 動的 import した puppeteer のうち使う部分だけ（バージョン差で型がずれるため緩くしておく） */
interface PuppeteerLike {
  launch(options?: LaunchOptions): Promise<Browser>;
}

/**
 * HTML を puppeteer で A4 PDF にする。失敗しても例外にせず false を返す（HTML はブラウザ印刷で PDF 化できる）。
 * Chrome の場所は PUPPETEER_EXECUTABLE_PATH で上書きできる。
 */
export async function htmlToPdf(html: string, outFile: string): Promise<boolean> {
  let puppeteer: PuppeteerLike;
  try {
    puppeteer = (await import('puppeteer')) as unknown as PuppeteerLike;
  } catch (err) {
    console.warn(`puppeteer を読み込めませんでした（${errorMessage(err).slice(0, 120)}）。report.html をブラウザで開いて「印刷 → PDF に保存」してください`);
    return false;
  }
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('print');
      await page.pdf({
        path: outFile,
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
      });
    } finally {
      await browser.close();
    }
    return true;
  } catch (err) {
    console.warn(`PDF 変換に失敗しました（${errorMessage(err).slice(0, 200)}）。`);
    console.warn('Chrome が見つからない場合は `npx puppeteer browsers install chrome` を実行するか、PUPPETEER_EXECUTABLE_PATH を設定してください。report.html をブラウザで印刷しても PDF にできます');
    return false;
  }
}
