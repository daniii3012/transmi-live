// Íconos de la PWA a partir de un SVG, con el Chrome instalado (sin dependencias nativas).
// Uso: node tools/icons.mjs
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Marca: chevron blanco sobre negro azulado y el cuadro rojo del bus; con margen de zona segura
// (80 %) para la versión enmascarable.
const mark = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#07090b"/>
  <g transform="translate(${256 - 256 * (1 - pad)} ${256 - 256 * (1 - pad)}) scale(${1 - pad})">
    <path d="M96 368 L256 112 L416 368" fill="none" stroke="#eceff2" stroke-width="56" stroke-linecap="square"/>
    <rect x="216" y="368" width="80" height="80" fill="#e5483b"/>
  </g>
</svg>`;
const OUT = new URL('../public/icons/', import.meta.url).pathname;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0.12], ['icon-512.png', 512, 0.12], ['maskable-512.png', 512, 0.3], ['apple-touch-icon.png', 180, 0.16], ['favicon-32.png', 32, 0.06]]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:#07090b">${mark(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(OUT + name, await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } }));
  console.log(name);
}
writeFileSync(OUT + 'mark.svg', mark(0.12).trim());
await browser.close();
