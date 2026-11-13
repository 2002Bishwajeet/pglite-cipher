// Throwaway spike code (issue #11): opens a bench URL in Playwright's WebKit (target mac-webkit) and
// waits until the page has posted its result to bench/device/serve.mjs.
// Usage: node bench/device/pw.mjs <url>
import { webkit } from 'playwright';

const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.log(`pageerror: ${e.message}`);
  });
  await page.goto(process.argv[2]);
  await page.waitForFunction(() => window.__benchPosted === true, undefined, { timeout: 3 * 60 * 60 * 1000, polling: 2000 });
  console.log(`WebKit ${browser.version()}`);
} finally {
  await browser.close();
}
