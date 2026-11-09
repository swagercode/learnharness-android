import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const output=resolve(process.argv[2]??'.local-preview/loading-preview');
await mkdir(output,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let encoder;
try{
 const page=await browser.newPage();
 await page.setViewport({width:540,height:1212,deviceScaleFactor:2});
 await page.goto(pathToFileURL(resolve('android/preview/loading.html')).href+'?capture');
 await page.evaluate(()=>window.previewReady);
 encoder=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-vcodec','png','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',resolve(output,'learnharness-loading-preview.mp4')],{stdio:['pipe','ignore','inherit']});
 const done=once(encoder,'close');
 for(let frame=0;frame<270;frame++){
  await page.evaluate(t=>window.renderFrame(t),frame/30);
  const png=await page.screenshot({type:'png'});
  if(!encoder.stdin.write(png))await once(encoder.stdin,'drain');
  if([36,120,240].includes(frame))await page.screenshot({path:resolve(output,`frame-${frame}.png`)});
  if(frame%90===0)console.log(`Rendered ${frame}/270 frames`);
 }
 encoder.stdin.end();
 const [code]=await done;if(code!==0)throw new Error(`ffmpeg exited ${code}`);
 console.log(resolve(output,'learnharness-loading-preview.mp4'));
}finally{if(encoder&&!encoder.stdin.writableEnded)encoder.kill();await browser.close();}
