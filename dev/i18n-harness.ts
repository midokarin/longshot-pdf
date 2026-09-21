import LongshotPdfPlugin from "../src/main";
import { LongshotSettingTab, normalizeSettings } from "../src/settings-tab";
import { ExportOptionsModal, confirmDialog } from "../src/modal";
import { PaginationPreviewModal } from "../src/preview";
import { DEFAULT_SETTINGS, AUTHOR_TEMPLATES, EXPORT_TYPE_LABELS } from "../src/settings";
import { computeGeometry, buildPageSpec, renderPage, renderLongImage } from "../src/compose";
import { buildAuthorSpec, authorBandMm, buildWatermarkSpec, loadImage, embedHiddenWatermark } from "../src/watermark";
import { buildPdf, buildLongPdf } from "../src/output";
import { mmToPx } from "../src/utils";
import { locale, t, translate, detectLocale } from "../src/i18n";
import { en } from "../src/locales/en";
import { ProgressNotice } from "../src/progress";
import { Notice, TFile } from "obsidian";

const report: string[] = [];
function check(ok: unknown, label: string) {
 if (!ok) throw new Error(label);
 report.push(label);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function englishOnly(root: HTMLElement, label: string) {
 if (locale !== "en") return;
 const text = root.textContent + [...root.querySelectorAll('[title],[placeholder],[aria-label]')].map(el => [el.getAttribute('title'), el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ')).join(' ');
 check(!/[\u3400-\u9fff]/.test(text), `${label}: no untranslated UI text`);
}
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)!;

async function run() {
 check(locale === (localStorage.getItem('language')?.startsWith('zh') ? 'zh' : 'en'), 'Host locale selected');
 for (const language of ['zh', 'zh-CN', 'zh-TW', 'en', 'en-GB', 'fr']) {
  localStorage.setItem('language',language);
  check(detectLocale() === (language.startsWith('zh')?'zh':'en'), `Locale fallback: ${language}`);
 }
 localStorage.setItem('longshot-test-legacy-api','1');
 localStorage.setItem('language','en');check(detectLocale()==='en','Legacy host uses stored English locale');
 localStorage.setItem('language','zh');check(detectLocale()==='zh','Legacy host uses stored Chinese locale');
 localStorage.removeItem('longshot-test-legacy-api');
 localStorage.setItem('language',locale);
 check(translate('en','当前：{0}', '中文 $& {0}') === 'Current: 中文 $& {0}', 'User text preserved during interpolation');
 check(translate('en','例如 {{name}}') === 'Example: {{name}}', 'Export variables preserved');
 check(Object.keys(en).length === 374, 'All 374 messages included');
 check(AUTHOR_TEMPLATES[0].name === (locale === 'en' ? 'Minimal' : '极简'), 'Built-in template names localized');
 check(EXPORT_TYPE_LABELS.long === t('长截图（整篇拼成一张长图）'), 'Static dropdown labels localized');
 const settings = {...DEFAULT_SETTINGS, authorEnabled:true, authorName:'Lin', authorText:'123456@qq.com', watermarkEnabled:true, watermarkText:'Example', hiddenWatermarkEnabled:true, authorTemplates:[]};
 let saves=0;
 const fakePlugin = {settings, defaults:DEFAULT_SETTINGS, manifest:{id:'longshot-pdf'}, saveSettings:async()=>{saves++}, chooseImageFile:async()=>false, chooseOutputDir:async()=>false};
 const file = Object.assign(new TFile(),{path:'Example.md',basename:'Example',name:'Example.md',extension:'md',parent:null});
 const app = {workspace:{getActiveFile:()=>file,on:()=>()=>{}},vault:{adapter:{},getAbstractFileByPath:()=>null}} as never;
 const tab = new LongshotSettingTab(app,fakePlugin as never);
 document.querySelector('#settings')!.appendChild(tab.containerEl);
 tab.display();
 const tabs = [t('截图'),t('纸张'),t('页眉页脚'),t('分页'),t('水印'),t('输出')];
 for(const label of tabs) {
  button(tab.containerEl,label).click();await tick();
  tab.containerEl.querySelectorAll('details').forEach(el=>el.open=true);
  englishOnly(tab.containerEl,label);
  check(tab.containerEl.querySelectorAll('.setting-item').length>0, `${label}: settings rendered`);
 }
 button(tab.containerEl,t('水印')).click();await tick();
 tab.containerEl.querySelectorAll('details').forEach(el=>el.open=true);
 const scroll = tab.containerEl.querySelector<HTMLElement>('.longshot-split-settings')!;
 scroll.scrollTop=150;const before=scroll.scrollTop;
 tab.containerEl.querySelector<HTMLElement>('.longshot-template-card')!.click();await tick();
 check(settings.authorName==='Lin'&&settings.authorText==='123456@qq.com','Template selection preserves author content');
 check(tab.containerEl.querySelector<HTMLElement>('.longshot-split-settings')!.scrollTop===before,'Template selection preserves scroll');
 check(saves>0,'Template selection saved settings');
 settings.authorName='林 $& {0}';settings.authorText='中文邮箱';settings.authorTemplates=[{id:'custom',name:'我的署名',style:AUTHOR_TEMPLATES[0].style}] as never;
 const restored=normalizeSettings(JSON.parse(JSON.stringify(settings)),DEFAULT_SETTINGS);
 check(restored.authorName===settings.authorName&&restored.authorTemplates[0].name==='我的署名','Existing user names and custom templates survive normalization');
 settings.authorName='Lin';settings.authorText='123456@qq.com';settings.authorTemplates=[];
 tab.display();await tick();
 const modal=new ExportOptionsModal(app,fakePlugin as never);modal.open();
 modal.contentEl.querySelectorAll('details').forEach(el=>el.open=true);
 englishOnly(modal.contentEl,'Quick settings');
 const typeSelect=[...modal.contentEl.querySelectorAll('select')].find(s=>s.querySelector('option[value="long"]'))!;
 const formatSelect=[...modal.contentEl.querySelectorAll('select')].find(s=>s.querySelector('option[value="pdf"]'))!;
 for(const type of ['paged','long'])for(const format of ['pdf','jpeg','png']) {
  typeSelect.value=type;typeSelect.dispatchEvent(new Event('change'));formatSelect.value=format;formatSelect.dispatchEvent(new Event('change'));await tick();
  check(settings.exportType===type&&settings.exportFormat===format,`${type}/${format}: option values unchanged`);
  const marginLabel=[...modal.contentEl.querySelectorAll('.setting-item-name')].find(el=>el.textContent===t('页边距'))!;
  const marginVisible=!marginLabel.closest('.longshot-modal-section')!.classList.contains('is-hidden');
  check(marginVisible===(type==='paged'||format==='pdf'),`${type}/${format}: margin controls visibility`);
  englishOnly(modal.contentEl,`${type}/${format} quick settings`);
 }
 modal.close();
 const result=confirmDialog(app,{title:t('渲染可能还没完成'),message:t('等待超时，仍未完成：{0}。\n现在导出这些内容可能显示不完整。','Mermaid'),confirmText:t('仍然导出'),cancelText:t('取消导出')});
 const dialog=document.querySelector<HTMLElement>('.modal-container:last-child')!;
 englishOnly(dialog,'Timeout dialog');button(dialog,t('取消导出')).click();check(await result===false,'Localized dialog cancels correctly');
 const plugin=new LongshotPdfPlugin() as any;
 const commands:any[]=[];const menuCallbacks:any[]=[];
 Object.assign(plugin,{app:{workspace:{on:(_e:string,cb:any)=>{menuCallbacks.push(cb);return ()=>{}}}},loadData:async()=>({}),addSettingTab:()=>{},addRibbonIcon:(_icon:string,title:string)=>{check(title===t('长截图导出（打开设置面板）'),'Ribbon tooltip localized')},addCommand:(c:any)=>commands.push(c),registerEvent:()=>{}});
 await plugin.onload();
 check(commands.length===7,'All seven commands registered');
 // The file picker must read only the selected PNG; no vault enumeration/read.
 const hiddenCanvas=document.createElement('canvas');hiddenCanvas.width=120;hiddenCanvas.height=120;
 hiddenCanvas.getContext('2d')!.fillRect(0,0,120,120);
 check(embedHiddenWatermark(hiddenCanvas,'local verification'),'Hidden watermark fixture encoded');
 const hiddenBlob=await new Promise<Blob>(resolve=>hiddenCanvas.toBlob(blob=>resolve(blob!),'image/png'));
 const hiddenFile=new File([hiddenBlob],'selected.png',{type:'image/png'});
 const originalRead=app.vault.readBinary;
 app.vault.readBinary=()=>{throw new Error('Unexpected vault read for a selected file')};
 await plugin.verifyHiddenWatermark(hiddenFile);
 check((Notice as any).messages.at(-1)===t('{0}\n隐水印内容：\n{1}','selected.png','local verification'),'Selected PNG decoded without vault access');
 const oldClick=HTMLInputElement.prototype.click;
 HTMLInputElement.prototype.click=function(){};
 try {
  commands.find(c=>c.id==='verify-hidden-watermark').callback();
  const picker=document.querySelector<HTMLInputElement>('input[type="file"][accept=".png,image/png"]')!;
  check(picker!==null,'Hidden watermark command opens a single-file picker');
  picker.dispatchEvent(new Event('cancel'));
  check(!picker.isConnected,'Cancelled file picker cleaned up');
 } finally {HTMLInputElement.prototype.click=oldClick;app.vault.readBinary=originalRead;}

 if(locale==='en') check(commands.every(c=>!/[\u3400-\u9fff]/.test(c.name)),'Command names localized');
 const labels:string[]=[];
 const menu={addItem:(cb:any)=>{const item={setTitle:(v:string)=>{labels.push(v);return item},setIcon:()=>item,onClick:()=>item};cb(item);return menu}};
 menuCallbacks[0](menu,file);check(labels.includes(t('长截图：导出这篇笔记')),'File menu localized');
 const progress=new ProgressNotice('Longshot PDF');progress.update(t('正在生成 PDF…'));progress.fail(t('图片解码失败'));
 const last=(Notice as any).messages.at(-1);
 check(last===t('{0} 失败\n{1}','Longshot PDF',t('图片解码失败')),'Progress failure localized');
 let warning='';await loadImage(app,'missing.png',text=>{warning=text});
 check(warning===t('找不到图片：{0}','missing.png'),'Missing-image warning localized');
 settings.exportType='paged';settings.exportFormat='pdf';
 const source=document.createElement('canvas');source.width=400;source.height=600;
 const ctx=source.getContext('2d')!;ctx.fillStyle='#fff';ctx.fillRect(0,0,400,600);ctx.fillStyle='#263d50';ctx.fillRect(30,30,300,10);
 const geo=computeGeometry(settings,source.width),vars={name:'Example',page:'1',pages:'1'};
 const spec=buildPageSpec(settings,geo,vars,{author:buildAuthorSpec(settings,geo.dpi,vars),watermark:buildWatermarkSpec(settings,geo.dpi,vars)});
 const page=renderPage(source,{start:0,end:600},spec);
 const pdf=await buildPdf([page],{paperWidthMm:geo.paperWidthMm,paperHeightMm:geo.paperHeightMm,format:'png',jpegQuality:.92});
 check(new TextDecoder().decode(pdf.slice(0,5))==='%PDF-','Localized paginated PDF generated');
 const long=renderLongImage(source,{author:spec.author,watermark:spec.watermark,authorBandPx:mmToPx(authorBandMm(settings),geo.dpi),paperColor:'#fff'});
 const longPdf=await buildLongPdf(long,{dpi:150,format:'png',jpegQuality:.92});
 check(new TextDecoder().decode(longPdf.slice(0,5))==='%PDF-','Localized long PDF generated');
 const preview=new PaginationPreviewModal(app,{source,spec,autoSlices:[{start:0,end:300},{start:300,end:600}],candidates:[],totalHeight:600,capacity:300},()=>{});preview.open();await tick();
 englishOnly(preview.contentEl,'Pagination preview');check(preview.contentEl.textContent?.includes(t('第 {0} 页 · 填充 {1}%',1,100)),'Page counter localized');preview.close();
 button(tab.containerEl,t('水印')).click();await tick();
 (window as any).__showQuick=()=>new ExportOptionsModal(app,fakePlugin as never).open();
 (window as any).__i18nResult={ok:true,locale,checks:report};
 document.querySelector('#log')!.textContent=report.join('\n');
}
run().catch(error=>{(window as any).__i18nResult={ok:false,error:String(error),checks:report};document.querySelector('#log')!.textContent=String(error);console.error(error)});
