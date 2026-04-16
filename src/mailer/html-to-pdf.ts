import { formatUnknownError } from '../utils/error-serialize.js';
import { logger } from '../utils/logger.js';

/** PDF 렌더 시 한글 등이 깨지지 않도록 웹폰트 힌트(오프라인이면 시스템 폰트로 대체) */
export function injectPdfChromeStyles(html: string): string {
  const inject = `<meta charset="utf-8"/><style>@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600&display=swap');html,body,table,td,th,p,span,h1,h2,h3,li,pre,code{font-family:'Noto Sans KR','Apple SD Gothic Neo',Malgun Gothic,sans-serif!important;}</style>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${inject}`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`;
}

/**
 * HTML을 PDF 바이너리로 변환. 실패 시 null (메일은 본문만으로 계속 발송).
 * `MONITOR_EMAIL_PDF=false` 이면 스킵.
 */
export async function renderHtmlToPdf(html: string, options?: { timeoutMs?: number }): Promise<Buffer | null> {
  if (process.env.MONITOR_EMAIL_PDF === 'false') {
    return null;
  }
  const timeoutMs = options?.timeoutMs ?? 120_000;
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(timeoutMs);
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const pdfUint8 = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
      });
      return Buffer.from(pdfUint8);
    } finally {
      await browser.close();
    }
  } catch (e) {
    logger.warn('HTML→PDF 변환 실패(첨부 생략, 본문은 그대로 발송)', { error: formatUnknownError(e) });
    return null;
  }
}
