/** Real Chromium layout regression sweep against an isolated, seeded server.
 * LH_LAYOUT_URL points to that server; no provider requests are allowed.
 * CHROME_PATH selects a locally installed browser. Outputs an audit JSON and
 * screenshots to LH_LAYOUT_ARTIFACTS. Use with synthetic sessions only. */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const url=process.env.LH_LAYOUT_URL??'http://127.0.0.1:3218';
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname)) throw Error('Use an isolated local server');
const output=resolve(process.env.LH_LAYOUT_ARTIFACTS??'.local-preview/mobile-layout');
mkdirSync(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const results=[];
const sizes=process.argv.includes('--quick')?[[320,640],[393,820]]:[[320,640],[393,820],[480,854],[600,960],[844,390],[1280,800]];
try { for(const [width,height] of sizes) {
 const page=await browser.newPage();
 await page.setViewport({width,height,deviceScaleFactor:1,isMobile:width<928,hasTouch:width<928});
 await page.setUserAgent('Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 LearnHarnessAndroid/0.4.1');
 await page.evaluateOnNewDocument(()=>{localStorage.setItem('lh:sidebar-open','0'); document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('lh-android'));});
 await page.setRequestInterception(true);
 page.on('request',r=>{
  if(r.url().startsWith(url+'/api/chat')&&r.method()==='POST') return void r.abort();
  return void r.continue();
 });
 const settle=()=>new Promise(r=>setTimeout(r,350));
 const go=async(path,selector)=>{await page.goto(url+path,{waitUntil:'domcontentloaded',timeout:120000});await page.waitForSelector(selector,{visible:true,timeout:60000});await settle();};
 const click=async(selector)=>{await page.waitForSelector(selector,{visible:true});await page.click(selector);await settle();};
 const audit=async(name,{inside,vertical=false}={})=>{
  await settle();
  const failures=await page.evaluate(({inside,vertical})=>{
   const failures=[];const vw=visualViewport?.width??innerWidth;const vh=visualViewport?.height??innerHeight;
   const left=visualViewport?.offsetLeft??0;const top=visualViewport?.offsetTop??0;
   if(document.documentElement.scrollWidth>innerWidth+1) failures.push({kind:'page width',width:document.documentElement.scrollWidth,viewport:innerWidth});
   const root=inside?document.querySelector(inside):document.body;
   if(!root) return [{kind:'missing surface',inside}];
   const name=e=>e.dataset.testid||e.getAttribute('aria-label')||e.textContent?.trim().slice(0,65)||e.tagName;
   for(const e of root.querySelectorAll('button,input,select,textarea,[contenteditable=true],a')) {
    const r=e.getBoundingClientRect(),s=getComputedStyle(e);
    if(!r.width||!r.height||s.visibility==='hidden'||e.closest('[inert],[hidden],nextjs-portal')) continue;
    let hidden=false, horizontalScroll=false;
    for(let p=e.parentElement;p;p=p.parentElement){const q=p.getBoundingClientRect(),c=getComputedStyle(p);if(!q.height||!q.width||c.visibility==='hidden')hidden=true;if(p.classList.contains('overflow-x-auto')&&p.scrollWidth>p.clientWidth+1)horizontalScroll=true;}
    if(hidden||r.bottom<top||r.top>top+vh)continue;
    if((r.left<left-1||r.right>left+vw+1)&&!horizontalScroll) failures.push({kind:'horizontal control',name:name(e),left:r.left,right:r.right});
   }
   for(const e of root.querySelectorAll('[data-lh-menu], [role=dialog]:not(.fixed)')){
    const r=e.getBoundingClientRect(); if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')continue;
    if(r.left<left-1||r.right>left+vw+1||r.top<top-1||r.bottom>top+vh+1)failures.push({kind:'surface bounds',name:name(e),rect:r.toJSON(),vw,vh});
   }
   for(const e of root.querySelectorAll('[data-testid=settings-content],[data-testid=chain-table],[data-lh-menu]')){
    if(e.clientWidth>0&&e.scrollWidth>e.clientWidth+1) failures.push({kind:'surface horizontal overflow',name:name(e),width:e.clientWidth,scrollWidth:e.scrollWidth});
   }
   if(vertical&&inside){const r=root.getBoundingClientRect();if(r.top<top-1||r.bottom>top+vh+1)failures.push({kind:'vertical surface',inside,rect:r.toJSON(),vh});}
   return failures;
  },{inside,vertical});
  results.push({width,height,name,failures});
  if(failures.length||['home','question','settings-agent','reading-returned'].includes(name)) await page.screenshot({path:resolve(output,`${width}x${height}-${name}.png`)});
  console.log(`${failures.length?'FAIL':'PASS'} ${width}x${height} ${name}${failures.length?' '+JSON.stringify(failures):''}`);
 };
 try {
  if(process.argv.includes('--content')){
   await go('/','[data-testid=import-notes]');
   await page.evaluate(async()=>{await fetch('/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({proseFontSize:24})});});
   await go('/chat/chat_mobile_practice_check','[data-testid=practice-dock]');await audit('practice-large-text');
   await go('/chat/chat_mobile_content_check','[data-testid=metadata-toggle]');await audit('long-prose-code-table-math');
   await click('[data-testid=metadata-toggle]');await audit('practice-metadata');await page.keyboard.press('Escape');
   await page.evaluate(async()=>{await fetch('/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dictationOnly:true,proseFontSize:24})});});
   await go('/','[data-testid=dictation-draft]');await audit('home-dictation-only');
   await go('/chat/chat_mobile_practice_check','[data-testid=voice-practice-controls]');await audit('practice-dictation-only');
   await page.evaluate(async()=>{await fetch('/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dictationOnly:false,proseFontSize:16})});});
  }else{
  await go('/','[data-testid=import-notes]'); await audit('home');
  await click('[aria-label="Graph display settings"]'); await audit('graph-settings');
  await page.keyboard.press('Escape'); await click('[data-testid=import-notes]'); await audit('import-menu');await page.keyboard.press('Escape');
  await click('[data-testid=open-chain-table]'); await audit('chains');
  const source='[data-testid^=cluster-checkbox-]:not([disabled])';
  if(await page.$(source)){
   await click(source);await audit('chain-selection');
   await click('[data-testid=chain-delete]');await audit('source-confirmation');
   await click('[data-testid=source-delete-cancel]');await click('[data-testid=chain-clear]');
  }
  await click('[data-testid=chain-table-close]');
  await click('[data-testid=stats-model]');await audit('home-model-menu');await page.keyboard.press('Escape');
  await page.evaluate(()=>document.querySelector('[data-testid=settings-entry]').click());
  await page.waitForSelector('[data-testid=settings-dialog]');
  for(const section of ['keys','agent','appearance','graph','keyboard','general']){
   await click(`[data-testid=settings-nav-${section}]`);await audit(`settings-${section}`,{inside:'[data-testid=settings-dialog]',vertical:true});
   if(section==='agent'){
    await click('[data-testid=models-advanced]');await audit('settings-advanced');
    await click('[data-testid=slot-model-strong]');await audit('settings-model-menu');
    // Simulate a keyboard reducing the visible app area while the menu is open.
    await page.setViewport({width,height:Math.max(260,Math.round(height*.55)),deviceScaleFactor:1,isMobile:width<928,hasTouch:width<928});
    await audit('settings-keyboard');await page.keyboard.press('Escape');
    await page.setViewport({width,height,deviceScaleFactor:1,isMobile:width<928,hasTouch:width<928});
   }
  }
  await click('[data-testid=settings-close]');
  await click('[data-testid=setup-cta-keys]');await audit('setup');await page.keyboard.press('Escape');
  await go('/chat/new','[data-testid=composer]');await audit('new-session');
  await go('/chat/new?mode=practice','[data-testid=composer]');await audit('practice-draft');
  await go('/chat/chat_mobile_layout_check','[data-testid=teach-check-reveal]');await audit('reading');
  const input='[data-testid=reading-thinking-field] [contenteditable=true]';
  await page.click(input);await page.keyboard.type('Keep this reading draft.');
  await click('[data-testid=teach-check-reveal]');await audit('question');
  // Real upward wheel: the dock must fold and restore the reading draft.
  await new Promise(r=>setTimeout(r,2100));
  const readingY=await page.$eval('[role=log]',e=>e.getBoundingClientRect().top+8);
  await page.mouse.move(width/2,readingY);
  for(let i=0;i<4;i++){await page.mouse.wheel({deltaY:-600});await settle();}
  await audit('reading-returned');
  const returned=await page.evaluate(()=>{const e=document.querySelector('[data-testid=reading-thinking-field]');return !!e&&!e.hidden&&e.textContent.includes('Keep this reading draft.');});
  results.push({width,height,name:'reading draft survives fold',failures:returned?[]:[{kind:'reading draft missing or hidden'}]});
  if(width<928){
   await click('[data-testid=question-dock-bar]');await new Promise(r=>setTimeout(r,2100));
   await page.$eval('[data-dock-scroll-area]',e=>{e.scrollTop=0;});
   const rect=await page.$eval('[data-dock-scroll-area]',e=>e.getBoundingClientRect().toJSON());
   const cdp=await page.createCDPSession();const x=Math.round(width/2),y=Math.round(rect.top+24);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+i*18}]});await new Promise(r=>setTimeout(r,35));}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle();await cdp.detach();
   const restored=await page.$eval('[data-testid=reading-thinking-field]',e=>!e.hidden&&e.textContent.includes('Keep this reading draft.'));
   results.push({width,height,name:'touch returns to reading',failures:restored?[]:[{kind:'touch did not restore reading'}]});
   if(!restored)await page.screenshot({path:resolve(output,`${width}x${height}-touch-error.png`)});
  }
  await click('[data-testid=stats-summary]');await audit('session-stats');await page.keyboard.press('Escape');
  if(await page.$('[data-testid=coverage-ring]')){await click('[data-testid=coverage-ring]');await audit('session-coverage');await page.keyboard.press('Escape');}
  }
 }catch(error){results.push({width,height,name:'script',failures:[{kind:error.message}]});console.log(`ERROR ${width}x${height}: ${error.message}`);await page.screenshot({path:resolve(output,`${width}x${height}-error.png`)});}
 await page.close();
} }finally{await browser.close();writeFileSync(resolve(output,'results.json'),JSON.stringify(results,null,2));}
console.log(`${results.filter(r=>!r.failures.length).length}/${results.length} layout checks passed`);
process.exitCode=results.some(r=>r.failures.length)?1:0;
