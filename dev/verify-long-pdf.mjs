// Check actual PDF page boxes and image placement, including asymmetric margins.
import { build } from 'esbuild';
import { localPdfPlugin } from '../build/jspdf-local.mjs';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
const bundle = await build({plugins:[localPdfPlugin()],stdin:{contents:'export { buildLongPdf } from "./src/output";',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',globalName:'pdfTest',alias:{obsidian:'./dev/obsidian-stub.ts'}});
const cache=path.join(os.homedir(),'Library/Caches/ms-playwright');
const executablePath=fs.readdirSync(cache).filter(n=>n.startsWith('chromium-')).sort().reverse().map(n=>path.join(cache,n,'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(p=>fs.existsSync(p));
const browser=await chromium.launch({executablePath});
try {
 const page=await browser.newPage();
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const cases=[
  {name:'default',w:900,h:2400,left:18,right:18,top:18,bottom:18,paper:210},
  {name:'asymmetric',w:900,h:240,left:25,right:12,top:8,bottom:20,paper:210},
  {name:'zero',w:500,h:500,left:0,right:0,top:0,bottom:0,paper:210},
  {name:'high-resolution',w:1800,h:4800,left:18,right:18,top:18,bottom:18,paper:210},
  {name:'extreme-height',w:20,h:22000,left:18,right:18,top:18,bottom:18,paper:210},
  {name:'landscape',w:22000,h:20,left:18,right:18,top:18,bottom:18,paper:297},
 ];
 fs.mkdirSync('work/long-pdf-margins',{recursive:true});
 for(const c of cases)for(const format of ['png','jpeg']) {
  const base64=await page.evaluate(async ({c,format})=>{
   const canvas=document.createElement('canvas');canvas.width=c.w;canvas.height=c.h;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#167b8a';ctx.fillRect(0,0,c.w,c.h);
   const data=await pdfTest.buildLongPdf(canvas,{dpi:150,format,jpegQuality:.9,layout:{paperWidthMm:c.paper,marginLeftMm:c.left,marginRightMm:c.right,marginTopMm:c.top,marginBottomMm:c.bottom,paperColor:'#ffffff'}});
   let s='';for(const b of new Uint8Array(data))s+=String.fromCharCode(b);return btoa(s);
  },{c,format});
  const bytes=Buffer.from(base64,'base64'); const text=bytes.toString('latin1');
  const box=/\/MediaBox\s*\[([^\]]+)\]/.exec(text)[1].trim().split(/\s+/).map(Number);
  const imageW=c.paper-c.left-c.right,imageH=imageW*c.h/c.w;
  const factor=Math.min(1,5080/Math.max(c.paper,imageH+c.top+c.bottom))*72/25.4;
  const near=(a,b)=>assert.ok(Math.abs(a-b)<.01,`${c.name} ${format}: ${a} != ${b}`);
  near(box[2],c.paper*factor);near(box[3],(imageH+c.top+c.bottom)*factor);
  assert.ok(Math.max(...box)<=14400.001);
  assert.equal((text.match(/\/Type\s*\/Page\b/g)||[]).length,1);
  // Read the compressed page drawing stream, independently of the layout implementation.
  const streamStart=text.indexOf('stream\n')+7, streamEnd=text.indexOf('\nendstream',streamStart);
  const stream=inflateSync(bytes.subarray(streamStart,streamEnd)).toString();
  const matrix=/([\d.e+-]+) 0 0 ([\d.e+-]+) ([\d.e+-]+) ([\d.e+-]+) cm/.exec(stream);
  assert.ok(matrix,'image placement matrix');
  near(Number(matrix[1]),imageW*factor);near(Number(matrix[2]),imageH*factor);
  near(Number(matrix[3]),c.left*factor);near(Number(matrix[4]),c.bottom*factor);
  fs.writeFileSync(`work/long-pdf-margins/${c.name}-${format}.pdf`,bytes);
  console.log(`PASS ${c.name}/${format}: page size, four margins, aspect ratio, single page`);
 }
}finally{await browser.close();}
