/** Seed a NEW throwaway directory for mobile-layout-smoke.mjs. Never use real
 * credentials. Start Next with LH_DATA_DIR=<output>/data and
 * LH_AUTH_FILE=<output>/auth.json, LH_IGNORE_ENV_KEYS=1. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]??`.local-preview/layout-fixture-${Date.now()}`);
if(existsSync(out))throw Error('Choose a new fixture directory');
mkdirSync(out,{recursive:true});
cpSync(new URL('../tests/fixtures/golden-data',import.meta.url),resolve(out,'data'),{recursive:true});
writeFileSync(resolve(out,'auth.json'),'{}');
const timestamp=Date.now();const zeroUsage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(id,content)=>({id,role:'assistant',api:'openai-responses',provider:'openai',model:'fixture-no-provider-calls',content,stopReason:'toolUse',usage:zeroUsage,timestamp});
const call=(id,name,args)=>({type:'toolCall',id,name,arguments:args});
const ack=(id,name)=>({id:`result_${id}`,role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:'ok'}],details:null,isError:false,timestamp});
const user={id:'fixture-user',role:'user',content:'Explain binary search.',timestamp};
const question='In a binary search, the last midpoint was 7 and its value was below the target.\n\n$$lo \\leftarrow mid + 1.$$\n\nThe previous bounds could have been:\n\n- **Case A:** lo = 0, hi = 15\n- **Case B:** lo = 4, hi = 11\n\nWhich information must remain available to continue correctly? Explain how the upper bound affects the next comparison.';
const lesson=Array(8).fill('Binary search remembers bounds so each comparison can discard a known part of the sorted array. Keeping the bounds lets the next comparison build on information already learned.').join('\n\n');
function save(id,messages,kind='teach'){writeFileSync(resolve(out,`data/chats/${id}.json`),JSON.stringify({version:1,id,title:'Binary search · mobile check',kind,createdAt:new Date(timestamp).toISOString(),updatedAt:new Date(timestamp).toISOString(),settings:{model:{provider:'openai',id:'fixture-no-provider-calls'}},messages}));}
save('chat_mobile_layout_check',[user,assistant('done',[call('done','probe_done',{})]),ack('done','probe_done'),assistant('quiz',[{type:'text',text:lesson},call('quiz','quiz',{nodeId:'binary-search',question,options:[{label:'Remember only the midpoint'},{label:'Keep the upper bound and the new lower bound'}],correctAnswer:'Keep the upper bound and the new lower bound',explanation:'The upper bound is still needed.'})])]);
const problemArgs={statement:question,mode:'recall',target:['very-long-proposition-id-'.repeat(12)],modelSolution:'The upper bound must remain available.'};
const problem=[user,assistant('problem',[call('problem','problem',problemArgs)]),ack('problem','problem')];
save('chat_mobile_practice_check',problem,'practice');
const long='long_unbroken_identifier_'.repeat(18);
const rich=`A long link: https://example.invalid/${long}\n\nInline code: \`${long}\`\n\n| First | Second | Third |\n|---|---|---|\n| ${long} | ${long} | ${long} |\n\n\`\`\`js\nconst ${long} = 'wide code should scroll locally';\n\`\`\`\n\n$$x_1+x_2+x_3+x_4+x_5+x_6+x_7+x_8+x_9+x_{10}=100$$\n\n`;
save('chat_mobile_content_check',[...problem,assistant('conclude',[call('conclude','conclude',{outcome:'solved',rung:'none',missClass:'none',retest:false,verdict:rich})]),ack('conclude','conclude')],'practice');
console.log(out);
cpSync(new URL('./android/fixtures/demo-ui.json',import.meta.url),resolve(out,'data/chats/chat_mobile_demo_check.json'));

// Replay a server-executed show_again result through the real chat projection.
const reused=JSON.parse(readFileSync(new URL('./android/fixtures/demo-ui.json',import.meta.url),'utf8'));
const original=reused.messages.find(m=>m.customType==='subagent-steer');
const material={id:original.id,kind:'demo',title:original.details.result.title,result:original.details.result,inverted:false};
save('chat_mobile_reused_demo_check',[...reused.messages,assistant('reuse-call',[call('reuse','show_again',{sourceId:original.id})]),
 {id:'reuse-result',role:'toolResult',toolCallId:'reuse',toolName:'show_again',content:[{type:'text',text:JSON.stringify({ok:true,sourceId:original.id})}],details:{ok:true,material},isError:false,timestamp},
 {...assistant('reuse-finished',[{type:'text',text:'The interactive workspace is here again.'}]),stopReason:'stop'}]);
