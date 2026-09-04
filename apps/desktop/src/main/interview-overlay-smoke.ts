import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OverlayManager } from "./overlay-manager";

/** Deterministic renderer/native-window regression; never uses live ASR or credentials. */
export async function runInterviewOverlaySmoke(options: { main: BrowserWindow; manager: OverlayManager; broadcast: (channel: string, payload: unknown) => void; setMode: (mode: "INTERVIEW" | "WRITTEN_TEST" | "IDLE") => void; click: (x: number, y: number) => Promise<void>; elementCenter: (window: BrowserWindow, selector: string) => Promise<{x:number;y:number}>; drag: (from: {x:number;y:number}, to: {x:number;y:number}) => Promise<void>; windowAt: (point:{x:number;y:number}) => Promise<string> }) {
  if (!process.env.INTERVIEW_COPILOT_TEST_DATA_PATH) throw new Error("Disposable test profile required");
  const { main, manager, broadcast } = options;
  const artifacts = process.env.INTERVIEW_OVERLAY_ARTIFACT_DIR!;
  if (!artifacts) throw new Error("Artifact directory required");
  await mkdir(artifacts, { recursive: true });
  const checks: string[] = [];
  const check = (ok: unknown, label: string) => { if (!ok) throw new Error(label); checks.push(label); process.stdout.write(`CHECK ${label}\n`); };
  const pause = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = <T>(window: BrowserWindow, code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const capture = async (window: BrowserWindow, name: string) => { await pause(150); await writeFile(join(artifacts, name), (await window.webContents.capturePage()).toPNG()); };
  await manager.prepare();
  await evaluate(main, `(async () => { await window.interviewCopilot.speechScript.upload({filename:'回归演讲稿.txt',mimeType:'text/plain',bytes:Array.from(new TextEncoder().encode('演讲稿测试段落。\\n'.repeat(80)))}); await window.interviewCopilot.overlay.setPreferences({interview:{leftPanel:'dialogue',layoutPreset:'classic_split',controlBar:{x:40,y:80,width:440,height:44},scriptWindow:{x:460,y:170,width:380,height:450}},behavior:{followLatestAnswer:true,followLatestQuestion:true}}); })()`);
  manager.enterInterviewMode(); options.setMode("INTERVIEW");
  manager.showAll();
  broadcast("session:state", "RUNNING");
  const question = manager.currentQuestionWindow!;
  const answer = manager.currentAnswerWindow!;
  await pause(350);
  const control = manager.currentControlWindow!;
  let clickCount=0;
  const click = async (window: BrowserWindow, selector: string) => {
    const point = await options.elementCenter(window, selector);
    const expectedWindow=window.getNativeWindowHandle().readBigUInt64LE().toString();
    await evaluate(window, `window.__clickEvents=[];if(!window.__clickTraceInstalled){window.__clickTraceInstalled=true;for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,e=>window.__clickEvents.push({type:e.type,trusted:e.isTrusted,target:e.target.getAttribute('aria-label'),buttons:e.buttons,time:Date.now()}),true);}`);
    const nativeHit=await options.windowAt(point);
    await options.click(point.x, point.y); await pause(250);
    await writeFile(join(artifacts,`click-${++clickCount}.json`),JSON.stringify({selector,point,nativeHit,expectedWindow,hud:manager.hudState,events:window.isDestroyed()?[]:await evaluate(window,'window.__clickEvents')},null,2));
  };
  await capture(control, "toolbar-before.png");
  const leftBefore = manager.hudState.transcriptVisible;
  await click(control, "button[aria-label='显示或隐藏左侧面板']");
  check(manager.hudState.transcriptVisible !== leftBefore && !question.isVisible(), "native toolbar click toggles transcript");
  await click(control, "button[aria-label='显示或隐藏左侧面板']");
  check(manager.hudState.transcriptVisible && question.isVisible(), "second native toolbar click restores transcript");
  const scriptBefore = manager.hudState.scriptVisible;
  await click(control, "button[aria-label='显示或隐藏演讲稿']");
  check(manager.hudState.scriptVisible !== scriptBefore && Boolean(manager.currentScriptWindow?.isVisible()) === !scriptBefore, "native toolbar opens script");
  await click(control, ".toolbar-end-button");
  check(manager.endInterviewConfirmOpen, "native toolbar opens exit confirmation");
  await click(manager.currentTransientWindow!, "[data-testid='confirm-cancel']");
  check(!manager.endInterviewConfirmOpen, "native exit cancellation restores toolbar");
  // Queue all questions first, then answer the older ones: catches latest-question mislabelling.
  for (let index = 1; index <= 25; index++) {
    broadcast("realtime:message", { type: "question_group_updated", groupId: `g${index}`, title: `测试问题 ${index}`, primaryQuestion: `测试问题 ${index}`, displayable: true, hasAnswerableQuestion: true, status: "active", items: [{ id: `q${index}`, questionId: `q${index}`, text: `测试问题 ${index}`, type: "NEW_TOPIC", answerable: true, state: "queued" }], slots: [], updatedAt: index });
  }
  for (let index = 1; index <= 24; index++) {
    broadcast("realtime:message", { type: "answer_start", answerId: `a${index}`, questionId: `q${index}`, groupId: `g${index}`, mode: "NORMAL", model: "local-fixture" });
    broadcast("realtime:message", { type: "answer_end", answerId: `a${index}`, text: `第 ${index} 题的测试回答。\n仅用于校验连续回答和滚动，不代表真实项目事实。` });
  }
  broadcast("realtime:message", { type: "runtime_error", questionId: "q25", code: "PROJECT_EVIDENCE_REQUIRED", message: "资料不足，请补充真实来源后重试。", retryable: true });
  await pause();
  const feed = await evaluate<{ count: number; first: string; last: string; top: number; tail: number }>(answer, `(() => { const list=[...document.querySelectorAll('.answer-feed-item')],region=document.querySelector('.overlay-scroll-region'); return {count:list.length,first:list[0]?.textContent,last:list.at(-1)?.textContent,top:region.scrollTop,tail:region.scrollHeight-region.scrollTop-region.clientHeight}; })()`);
  check(feed.count === 25 && feed.first.includes("测试问题 1") && feed.first.includes("第 1 题"), "25 questions retained with correctly paired answers");
  check(feed.last.includes("资料不足") && feed.last.includes("重试本题"), "blocked question keeps its own reason and retry");
  check(feed.top > 0 && feed.tail < 3, "answer feed scrolls to newest question");
  await capture(answer, "answer-feed.png");
  broadcast("realtime:message", { type: "question_group_updated", groupId: "g26", title: "缺证据之后的新问题", primaryQuestion: "缺证据之后的新问题", displayable: true, hasAnswerableQuestion: true, status: "active", items: [{id:"q26",questionId:"q26",text:"缺证据之后的新问题",type:"NEW_TOPIC",answerable:true,state:"queued"}],slots:[],updatedAt:26 });
  broadcast("realtime:message", {type:"answer_start",answerId:"a26",questionId:"q26",groupId:"g26",mode:"NORMAL",model:"fixture"});
  broadcast("realtime:message", {type:"answer_end",answerId:"a26",text:"最新的回答在这里。"}); await pause();
  check(await evaluate<boolean>(answer, `document.querySelector('.answer-feed-item:last-child')?.textContent.includes('最新的回答在这里')`), "old no-evidence card never pins beneath a newer answer");
  await capture(answer, "answer-chronology.png");
  const remote = { source: "remote", final: Array.from({ length: 58 }, (_, index) => ({ id: `r${index}`, source: "remote", text: `面试官问题 ${index + 1}`, startMs: index * 1000, endMs: index * 1000 + 400, final: true })) };
  broadcast("realtime:transcript", remote);
  broadcast("realtime:transcript", { source: "mic", final: [{id:"m1",source:"mic",text:"我的回答显示在右侧。",startMs:58500,endMs:58900,final:true}] });
  for (let index = 1; index <= 30; index++) {
    broadcast("realtime:transcript", { ...remote, partial: {id:"live",source:"remote",text:`正在持续识别 ${index}：${"语音内容。".repeat(index)}`,startMs:59000,endMs:59000+index*50,final:false} });
    broadcast("realtime:transcript", { source:"mic", final:[{id:"m1",source:"mic",text:"我的回答显示在右侧。",startMs:58500,endMs:58900,final:true}], partial:{id:"mic-live",source:"mic",text:`麦克风同步更新 ${index}`,startMs:60000,endMs:60000+index*50,final:false} });
    await pause(55);
  }
  await pause();
  const dialogue = await evaluate<{count:number;text:string;tail:number;left:number;right:number}>(question, `(() => {const region=document.querySelector('.overlay-scroll-region'),left=document.querySelector('.dialogue-interviewer'),right=document.querySelector('.dialogue-candidate'); return {count:document.querySelectorAll('.dialogue-block').length,text:region.textContent,tail:region.scrollHeight-region.scrollTop-region.clientHeight,left:left.getBoundingClientRect().x,right:right.getBoundingClientRect().x};})()`);
  check(dialogue.count === 61 && dialogue.text.includes("正在持续识别 30") && dialogue.text.includes("麦克风同步更新 30"), "58 finals and simultaneous remote/mic partials continue rendering");
  check(dialogue.tail < 3 && dialogue.right > dialogue.left, "dialogue follows text growth with left/right speakers");
  await capture(question, "dialogue.png");
  manager.hideAll(); await pause(); manager.showAll(); await pause(250);
  check(await evaluate<boolean>(question, `document.body.textContent.includes('正在持续识别 30')`), "transcript survives hide/show");
  manager.toggleScript();
  await pause(300);
  const script = manager.currentScriptWindow!;
  if (!manager.hudState.scriptVisible) manager.toggleScript();
  await pause();
  check(script.isVisible() && !script.isFocusable() && !manager.isLayoutEditMode, "script is non-focusable and visible during normal interview");
  const before = script.getBounds();
  const headerPoint = await options.elementCenter(script, ".script-overlay-header strong");
  await evaluate(script, `window.__gestureEvents=[];for(const t of ['pointerdown','pointermove','pointerup','blur']) window.addEventListener(t,e=>{if(t!=='pointermove'||e.buttons)window.__gestureEvents.push([t,e.buttons,e.screenX,e.screenY,e.target.className]);});`);
  await options.drag(headerPoint, {x:headerPoint.x+60,y:headerPoint.y+40}); await pause();
  await writeFile(join(artifacts,"gesture.json"),JSON.stringify({before,after:script.getBounds(),events:await evaluate(script,'window.__gestureEvents')},null,2));
  check(script.getBounds().x !== before.x || script.getBounds().y !== before.y, "native script title drag moves outside layout-edit mode");
  const resizePoint = await options.elementCenter(script, ".script-resize-e");
  await options.drag(resizePoint, {x:resizePoint.x+60,y:resizePoint.y}); await pause();
  check(script.getBounds().width > before.width, "native script handle resizes outside layout-edit mode");
  await click(script, ".script-reading-controls button");
  await pause(700);
  check(await evaluate<boolean>(script, `document.querySelector('.script-overlay-scroll').scrollTop > 0`), "native script button starts automatic scrolling");
  const answerBefore = answer.getBounds();
  manager.setNativeWindowBounds("answer", { ...answerBefore, width: answerBefore.width + 40 });
  check(answer.getBounds().width === answerBefore.width, "answer layout remains locked during interview");
  manager.setCaptureProtection(true);
  check(script.isContentProtected() && !script.isFocusable(), "script retains OS capture protection and no-focus behavior");
  manager.setShareMode(true); await pause();
  check(!script.isVisible() && !answer.isVisible() && !question.isVisible(), "share mode hides all content windows");
  manager.setShareMode(false); await pause();
  check(script.isVisible(), "leaving share mode restores script visibility");
  await capture(script, "script.png");
  for (let cycle=0; cycle<3; cycle++) {
    await click(control, ".toolbar-end-button");
    await click(manager.currentTransientWindow!, "[data-testid='confirm-end']");
    await pause(300);
    await writeFile(join(artifacts,`exit-${cycle}.json`),JSON.stringify({hud:manager.hudState,controlVisible:control.isVisible(),mainVisible:main.isVisible(),transientDestroyed:!manager.currentTransientWindow},null,2));
    check(!manager.hudState.running && !control.isVisible() && main.isVisible(), `native exit cycle ${cycle+1} restores main window`);
    if(cycle<2){manager.enterInterviewMode();options.setMode("INTERVIEW");manager.showAll();await pause(200);}
  }
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ok:true,checks,feed,dialogue}, null, 2));
  return {ok:true,checks};
}
