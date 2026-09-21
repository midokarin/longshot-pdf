import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const cache = path.join(os.homedir(),'Library/Caches/ms-playwright');
const folder=fs.readdirSync(cache).filter(x=>x.startsWith('chromium-')).sort().reverse().find(x=>fs.existsSync(path.join(cache,x,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')));
const browser=await chromium.launch({executablePath:path.join(cache,folder,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')});
fs.mkdirSync('work/i18n-review',{recursive:true});
try {
 for(const locale of ['zh','en']) {
  const page=await browser.newPage({viewport:{width:1200,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(value=>localStorage.setItem('language',value),locale);
  await page.goto('http://127.0.0.1:8777/dev/i18n-harness.html');
  await page.waitForFunction(()=>window.__i18nResult,null,{timeout:60000});
  const result=await page.evaluate(()=>window.__i18nResult);
  assert(result.ok,JSON.stringify(result));assert.deepEqual(errors,[]);
  console.log(`${locale}: ${result.checks.length} checks passed`);
  await page.locator('#log').evaluate(el=>el.remove());
  await page.screenshot({path:`work/i18n-review/${locale}-settings.png`,fullPage:true});
  for(const width of [1200,620]) {
   await page.setViewportSize({width,height:1000});
   const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
   assert(fits,`${locale} settings overflow at ${width}px`);
  }
  await page.screenshot({path:`work/i18n-review/${locale}-narrow.png`,fullPage:true});
  await page.setViewportSize({width:1200,height:1000});
  await page.evaluate(()=>window.__showQuick());
  await page.screenshot({path:`work/i18n-review/${locale}-quick.png`,fullPage:true});
  await page.setViewportSize({width:620,height:1000});
  const quickFits=await page.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth);
  assert(quickFits,`${locale} quick settings overflow at 620px`);
  await page.close();
 }
} finally {await browser.close();}
