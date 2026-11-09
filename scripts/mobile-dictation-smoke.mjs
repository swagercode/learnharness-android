import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

// Run against scripts/mobile-layout-fixtures.mjs data only. Provider calls
// and answer writes are intercepted; capture uses Chromium's synthetic mic.
const origin = process.argv[2] ?? 'http://127.0.0.1:3218';
const voiceOnly = process.argv.includes('--voice-only');
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Local fixture server required');
const browser = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const appearanceResponse = await fetch(origin+'/api/settings');
if(!appearanceResponse.ok)throw new Error('Could not read fixture settings');
const originalAppearance = (await appearanceResponse.json()).settings?.appearance??{};
try {
 const page = await browser.newPage();
 await page.setViewport({width:412,height:924,isMobile:true,hasTouch:true,deviceScaleFactor:1});
 await page.evaluateOnNewDocument(() => {
  localStorage.setItem('lh:sidebar-open','0');
  window.__speech = {text:'',frames:0};
  const NativeSocket=window.WebSocket;
  window.WebSocket=class extends EventTarget {
   static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
   readyState=0;
   constructor(url,protocols){super();if(!String(url).startsWith('wss://api.deepgram.com/'))return new NativeSocket(url,protocols);setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));},20);}
   send(data){if(typeof data!=='string'){window.__speech.frames++;return;}if(JSON.parse(data).type==='CloseStream')setTimeout(()=>{this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:window.__speech.text}]}})}));this.close();},150);}
   close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1000}));}
  };
 });
 const submissions=[];
 await page.setRequestInterception(true);
 page.on('request',r=>{
  const path=new URL(r.url()).pathname;
  if(path==='/api/stt/token')return void r.respond({status:200,contentType:'application/json',body:JSON.stringify({token:'fixture-token'})});
  if(path.startsWith('/api/chat')&&r.method()==='POST'){submissions.push(JSON.parse(r.postData()));return void r.respond({status:409,contentType:'application/json',body:JSON.stringify({message:'Fixture intercepted submission'})});}
  return void r.continue();
 });
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const click=async selector=>{await page.waitForSelector(selector,{visible:true});await page.click(selector);await pause(300);};
 const start=async text=>{await page.evaluate(text=>{window.__speech.text=text;window.__speech.frames=0;},text);await click('[data-testid=dictation-toggle]');await page.waitForFunction(()=>window.__speech.frames>0);};
 const stop=async()=>{await click('[aria-label="Stop dictation"]');await page.waitForSelector('[data-testid=dictation-toggle]');};
 await page.goto(origin,{waitUntil:'domcontentloaded'});
 await page.evaluate(async ({voiceOnly,originalAppearance})=>{
  const response=await fetch('/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...originalAppearance,dictationOnly:voiceOnly})});
  if(!response.ok)throw new Error('Could not set fixture input mode');
 },{voiceOnly,originalAppearance});
 await page.goto(origin+'/chat/chat_mobile_layout_check',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('[data-testid=teach-check-reveal]',{timeout:90000});
 await start('Reading before the exercise.');await stop();
 if(voiceOnly)await click('[data-testid=reading-thinking-field] button[aria-expanded=false]');
 assert.match(await page.$eval('[data-testid=reading-thinking-field]',e=>e.textContent),/Reading before the exercise/);
 await click('[data-testid=teach-check-reveal]');await pause(2200);
 const y=await page.$eval('[role=log]',e=>e.getBoundingClientRect().top+8);
 await page.mouse.move(206,y);
 for(let i=0;i<4;i++){await page.mouse.wheel({deltaY:-600});await pause(350);}
 await page.waitForFunction(()=>!document.querySelector('[data-testid=reading-thinking-field]').hidden);
 await start('Reading after scrolling back.');await stop();
 await click('[data-testid=question-dock-bar]');await pause(2200);
 await start('My reasoning belongs to this question.');await stop();
 if(voiceOnly)await click('[data-testid=question-dock] button[aria-expanded=false]');
 const question=await page.$eval('[data-testid=question-dock]',e=>e.textContent);
 assert.match(question,/My reasoning belongs to this question/, 'reopened question must receive the speech');
 console.log(`PASS audio worklet frames; reading → question → reading → reopened question routing (${voiceOnly?'voice only':'text fields'})`);
 await page.$eval('[data-kbdrow="1"]',e=>e.click());
 await start('Final words before submitting.');
 await page.$eval('[data-testid=question-dock] form',e=>e.requestSubmit());
 await page.waitForFunction(()=>!!document.querySelector('[data-testid=dictation-toggle]'));
 await pause(600);
 assert.equal(submissions.length,1,'one answer submission');
 assert.match(JSON.stringify(submissions[0]),/My reasoning belongs to this question\. Final words before submitting\./);
 assert.match(JSON.stringify(submissions[0]),/Reading before the exercise\. Reading after scrolling back\./);
 console.log('PASS submitting while recording includes the final speech and preserved reading thoughts');
 await page.screenshot({path:resolve(`.local-preview/mobile-v9-dictation${voiceOnly?'-voice':''}.png`)});
} finally {
 try {
  const response=await fetch(origin+'/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(originalAppearance)});
  if(!response.ok)throw new Error('Could not restore fixture input mode');
 } finally { await browser.close(); }
}
