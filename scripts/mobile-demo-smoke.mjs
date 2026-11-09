import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const origin=process.argv[2]??'http://127.0.0.1:3218';
if(new URL(origin).hostname!=='127.0.0.1')throw new Error('Local fixture server required');
const reused=process.argv.includes("--reused");
const scope=reused?"[data-testid=show-again-card] ":"";
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 for(const [width,height] of [[320,700],[412,924],[844,390]]){
  const page=await browser.newPage();await page.setViewport({width,height,isMobile:true,hasTouch:true});
  await page.evaluateOnNewDocument(()=>{try{localStorage.setItem('lh:sidebar-open','0')}catch{}});
  await page.setRequestInterception(true);page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/chat'))return void r.abort();return void r.continue();});
  await page.goto(origin+'/chat/'+(reused?'chat_mobile_reused_demo_check':'chat_mobile_demo_check'),{waitUntil:'domcontentloaded'});
  await page.waitForSelector(scope+'[data-testid=demo-fullscreen-open]',{visible:true,timeout:90000});
  const iframe=await page.$(scope+'[data-testid=demo-iframe]'),frame=await iframe.contentFrame();
  await frame.waitForSelector('#count');
  const instance=await frame.evaluate(()=>window.instance);
  // Finish iframe auto-sizing before interacting with the transcript. Scroll
  // as a user does: browser scrollIntoView can race the chat's tail following.
  await new Promise(r=>setTimeout(r,1200));
  const openFullscreen=async()=>{
   const selector=scope+'[data-testid=demo-fullscreen-open]';
   for(let attempt=0;attempt<8;attempt++){
    const rect=await page.$eval(selector,e=>e.getBoundingClientRect().toJSON());
    if(rect.y>=80&&rect.bottom<=height-190){
     await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);return;
    }
    await page.mouse.move(30,Math.min(200,height/2));
    await page.mouse.wheel({deltaY:rect.y-Math.min(200,Math.round(height*.3))});
    await new Promise(r=>setTimeout(r,400));
   }
   throw new Error('Demo fullscreen button could not be reached by scrolling');
  };
  await frame.$eval('#count',e=>e.click());
  await openFullscreen();
  await page.waitForFunction(scope=>document.querySelector(scope+'[data-testid=demo-card]').matches(':modal'),{},scope);
  const assertBounds=async()=>{
   const bounds=await page.$eval(scope+'[data-testid=demo-fullscreen-close]',e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}});
   assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=width+1&&bounds.bottom<=height+1,JSON.stringify(bounds));assert.ok(bounds.width>=44&&bounds.height>=44,'visible touch-sized exit');
  };
  await assertBounds();
  assert.equal(await frame.evaluate(()=>window.instance),instance,'fullscreen keeps iframe state');
  assert.equal(await frame.$eval('#count',e=>e.textContent),'1');
  await frame.click('#tail');await assertBounds();
  await page.screenshot({path:resolve(`.local-preview/mobile-v9-${reused?'reused-':''}demo-${width}.png`)});
  await page.click(scope+'[data-testid=demo-fullscreen-close]');
  await page.waitForFunction(scope=>!document.querySelector(scope+'[data-testid=demo-card]').matches(':modal'),{},scope);
  assert.equal(await frame.evaluate(()=>window.instance),instance,'close keeps iframe state');
  await openFullscreen();
  await page.waitForFunction(scope=>document.querySelector(scope+'[data-testid=demo-card]').matches(':modal'),{},scope);
  await frame.click('#count');await page.keyboard.press('Escape');
  await page.waitForFunction(scope=>!document.querySelector(scope+'[data-testid=demo-card]').matches(':modal'),{},scope);
  assert.equal(await frame.$eval('#count',e=>e.textContent),'2');
  assert.equal(await page.$(scope+'[data-testid=demo-download]'),null);
  assert.equal(await page.evaluate(()=>document.documentElement.style.overflow),'');
  console.log(`PASS ${reused?'reused demo':'original demo'} ${width}x${height}: fullscreen, scrolling, visible Close, iframe Escape, retained state, restored page`);
  await page.close();
 }
}finally{await browser.close();}
