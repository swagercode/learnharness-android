import React, { act, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { appendToPrimaryInput } from "../components/dictation.tsx";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";

const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent });
Object.assign(document, { getSelection: () => null, oninput: null });
window.HTMLElement.prototype.focus = function () {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ settings: { appearance: { dictationOnly: true } } });
const roots: { root: Root; host: HTMLElement }[] = [];
function ModeSwitch() { const { appearance, onAppearanceChange } = useAppearance(); return <button data-testid="toggle-mode" onClick={() => onAppearanceChange({ dictationOnly: !appearance.dictationOnly })}>Switch mode</button>; }
async function mount(child: React.ReactNode) {
 const host = document.createElement("div") as unknown as HTMLElement; document.body.append(host);
 const root = createRoot(host); roots.push({root,host});
 await act(async () => root.render(<AppearanceProvider><ModeSwitch />{child}</AppearanceProvider>));
 return host;
}
async function click(host: HTMLElement, selector: string) { const element=host.querySelector<HTMLElement>(selector); assert.ok(element,selector); await act(async()=>element.click()); }
async function dictate(text: string) { await act(async()=>assert.equal(appendToPrimaryInput(text),true)); }
afterEach(async()=>{ for(const {root,host} of roots.splice(0)){ await act(async()=>root.unmount());host.remove(); } });
process.on("exit",()=>{globalThis.fetch=originalFetch});

describe("dictation-only space saving",()=>{
 it("validates and persists the explicit setting, with typing enabled by default",()=>{
  assert.deepEqual(parseAppearanceSettingsBody({dictationOnly:true}),{ok:true,settings:{dictationOnly:true}});
  assert.equal(parseAppearanceSettingsBody({dictationOnly:"true"}).ok,false);
  const saved=sanitizeUserSettings({version:1,appearance:{dictationOnly:true}});
  assert.equal(resolveSettings(saved).appearance.dictationOnly,true);
  assert.equal(resolveSettings(null).appearance.dictationOnly,false);
 });
 it("keeps reading thoughts when hidden, releases their dictation target, and restores typing without losing words",async()=>{
  let hide!:(hidden:boolean)=>void; let draft="";
  function Field(){const [hidden,setHidden]=useState(false);hide=setHidden;return <ReadingThinkingField value="" revision={0} hidden={hidden} claim onChange={v=>{draft=v}}/>}
  const host=await mount(<Field/>);
  assert.equal(host.querySelector("[data-file-path-input]"),null);
  await dictate("Saved reading thoughts"); assert.equal(draft,"Saved reading thoughts");
  await act(async()=>hide(true)); assert.equal(host.querySelector("[data-testid=reading-thinking-field]")?.hasAttribute("hidden"),true);
  assert.equal(appendToPrimaryInput("Do not write to a hidden field"),false);
  await act(async()=>hide(false)); await click(host,"[data-testid=toggle-mode]");
  assert.match(host.querySelector("[data-file-path-input]")!.textContent!,/Saved reading thoughts/);
 });
 it("records and submits a dictated text answer with no text box",async()=>{
  let answer:unknown;
  const host=await mount(<QuestionDock toolName="ask_user_question" toolCallId="voice-text" input={{question:"Explain the distinction."}} expanded onExpand={()=>{}} onSubmit={v=>{answer=v}}/>);
  assert.equal(host.querySelector("[data-file-path-input]"),null);
  await dictate("A spoken answer");
  assert.match(host.textContent!,/3 words/);
  const form=host.querySelector("form")!; await act(async()=>form.dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true})));
  assert.match(JSON.stringify(answer),/A spoken answer/);
 });
 it("routes dictation back to the preserved reading draft when an opened check folds",async()=>{
  let expand!:(value:boolean)=>void;let reading="";let answer:unknown;
  function Fields(){const [open,setOpen]=useState(false);expand=setOpen;return <>
   <ReadingThinkingField value="" revision={0} hidden={open} claim={!open} onChange={v=>{reading=v}}/>
   <QuestionDock toolName="ask_user_question" toolCallId="fold-check" input={{question:"Explain the bound."}} expanded={open} dictationClaim={open} onExpand={()=>setOpen(true)} onSubmit={v=>{answer=v}}/>
  </>}
  const host=await mount(<Fields/>);await dictate("Before the exercise.");
  await act(async()=>expand(true));await dictate("My exercise answer.");
  await act(async()=>expand(false));await dictate("Back to the lesson.");
  assert.equal(reading,"Before the exercise. Back to the lesson.");
  await act(async()=>expand(true));await act(async()=>host.querySelector("form")!.dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true})));
  assert.match(JSON.stringify(answer),/My exercise answer/);assert.doesNotMatch(JSON.stringify(answer),/Back to the lesson/);
 });
 it("routes speech into a selected custom answer instead of the thinking field",async()=>{
  let answer:unknown;
  const host=await mount(<QuestionDock toolName="ask_user_question" toolCallId="voice-other" input={{question:"Choose one",options:[{label:"First"},{label:"Second"}]}} expanded onExpand={()=>{}} onSubmit={v=>{answer=v}}/>);
  await click(host,"[data-testid=other-option]"); await dictate("My custom option");
  await act(async()=>host.querySelector("form")!.dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true})));
  assert.match(JSON.stringify(answer),/My custom option/);
  assert.equal(host.querySelector("[data-file-path-input]"),null);
 });
 it("keeps practice dictation and submission working without an editor",async()=>{
  let answer="";
  const host=await mount(<PracticeDock problemCallId="voice-practice" input={{statement:"Work out the next bound."}} expanded onExpand={()=>{}} onSubmit={v=>{answer=v}}/>);
  await dictate("My reasoning"); await click(host,"[data-testid=practice-send]");
  assert.equal(answer,"My reasoning"); assert.equal(host.querySelector("[data-file-path-input]"),null);
 });
});
