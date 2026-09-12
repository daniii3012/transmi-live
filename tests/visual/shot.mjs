// Capturas de referencia con el Chrome instalado (puppeteer-core, sin descargar navegadores).
// Uso: node tests/visual/shot.mjs <url> <nombre> [desktop|mobile|both] [--wait=ms] [--eval=js]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const [url, name = 'shot', which = 'both', ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split(/=(.*)/s)).map(([k, v]) => [k, v ?? true]));
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
try {
  for (const kind of which === 'both' ? ['desktop', 'mobile'] : [which]) {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.setViewport(VIEWPORTS[kind]);
    if (kind === 'mobile') await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => window.__map?.loaded?.() && window.__map?.areTilesLoaded?.(), { timeout: 45000 }).catch(() => logs.push('[shot] mapa sin terminar'));
    if (opt.eval) { await page.evaluate(opt.eval); }
    await new Promise((r) => setTimeout(r, Number(opt.wait ?? 1500)));
    const file = `${OUT}${name}-${kind}.png`;
    await page.screenshot({ path: file });
    const fps = await page.evaluate(() => window.__fps?.() ?? null).catch(() => null);
    console.log(file, fps ? `fps=${fps}` : '');
    for (const l of logs.filter((l) => !/Download the|DevTools/.test(l))) console.log('  ', l.slice(0, 300));
    await page.close();
  }
} finally {
  await browser.close();
}
