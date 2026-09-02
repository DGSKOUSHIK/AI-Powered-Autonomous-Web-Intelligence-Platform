import { chromium, type Browser } from "playwright";

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export interface RenderResult {
  html: string;
  text: string;
  ok: boolean;
  status: number;
}

export async function renderPage(
  url: string,
  timeoutMs: number,
  waitAfterMs = 8000,
): Promise<RenderResult> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch {
    // Playwright/Chromium not available (e.g. not installed). Skip render.
    return { html: "", text: "", ok: false, status: 0 };
  }
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  context.setDefaultTimeout(timeoutMs);
  const page = await context.newPage();
  let status = 0;
  try {
    const resp = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    status = resp?.status() ?? 0;
    // let JS render / lazy content load
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) });
    } catch {
      // networkidle not reached; continue
    }
    await page.waitForTimeout(waitAfterMs);
    const html = await page.content();
    const text = await page.evaluate(() =>
      document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "",
    );
    return { html, text, ok: status === 0 || (status >= 200 && status < 400), status };
  } catch {
    return { html: "", text: "", ok: false, status: 0 };
  } finally {
    await context.close();
  }
}

export async function shutdownBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      // ignore
    }
    browserPromise = null;
  }
}