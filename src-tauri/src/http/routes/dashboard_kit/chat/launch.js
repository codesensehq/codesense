// SPDX-License-Identifier: MIT
// Launch-on-send machine and the page outbox (AC5, AC6). Pure over an injected transport and clock, so Node tests drive it on a fake clock.
// States: idle -> starting -> slow(20 s) | failed(reason: timeout, exited, or a launch error) | joined; a startup-stuck launched row holds starting with the timers stopped (`stuck`). Sends while starting go to the outbox, never a second launch and never the role queue.
// Confirmable calls (openWorkspace, sendAsHuman) run one at a time: the dispatcher answers `busy` to a second while a host confirm waits.
import {leadRowsOf} from './presence.js';
import {isBusy} from './chat-core.js';
export const parseFailure=error=>{
 const code=String((error&&error.message)||error||'unavailable').trim();
 if(/^busy\b/.test(code))return {kind:'busy',code};
 if(/^denied:/.test(code))return {kind:'denied',code,why:code.replace(/^denied:\s*/,'')};
 if(/^unavailable:/.test(code))return {kind:'unavailable',code,why:code.replace(/^unavailable:\s*/,'')};
 return {kind:'other',code};
};
// rowsOf(sessions) is this chat's peer rows (the story's lead rows by default); queue, when set, is where a message goes while no peer runs, in place of a launch (the sprint chat).
export function createLaunch({transport,clock,storyId,leadRole,timers,card,onChange=()=>{},rowsOf=sessions=>leadRowsOf(sessions,storyId,leadRole),queue=null}){
 let state='idle',failure=null,sendFailure=null,rows=[],launchResult=null,settled=false,stuck=false,seq=0,ids=0,chain=Promise.resolve(),slowTimer=null,failTimer=null,staleDead=new Set();
 const messages=[],outbox=[],peerRows=()=>rowsOf(rows);
 // A dead lead: exited, or an idle tab whose agent crashed (it stays in the roster).
 const died=row=>row.state==='exited'||row.effectiveStatus==='crashed';
 // The launch's own live lead: any row but a dead one or a startup-stuck one.
 const live=()=>peerRows().find(row=>!died(row)&&row.needsYouKind!=='startup')||null,emit=()=>onChange();
 // The launched lead is the row of the sessionId the openWorkspace verb resolved with; the handle is rebound in place, so no other row counts.
 const launchedRow=()=>launchResult&&launchResult.sessionId?peerRows().find(row=>row.sessionId===launchResult.sessionId)||null:null;
 const starting=()=>state==='starting'||state==='slow';
 const clearTimers=()=>{if(slowTimer!==null)clock.clearTimeout(slowTimer);if(failTimer!==null)clock.clearTimeout(failTimer);slowTimer=failTimer=null;};
 const enqueue=job=>{chain=chain.then(job,job);return chain;};
 const texts=list=>list.map(item=>item.text).join('\n\n');
 const deliver=(list,handle)=>{
  // busyAtSend is read once, here: the Queued/Delivered rule (chat-core) asks whether the lead was busy when the message went.
  const busy=handle===queue||isBusy(peerRows().find(row=>row.handle===handle));list.forEach(item=>{item.mark='sent';item.busyAtSend=busy;});sendFailure=null;emit();
  // The id sendAsHuman returns is how a bubble is matched to its inbox row later; a failed send keeps the message, with a Retry.
  return enqueue(()=>transport.send(handle,texts(list))).then(result=>{
   // A resolved status other than 'sent' (for example 'invalid') is a failure too.
   if(result&&result.status!==undefined&&result.status!=='sent'){list.forEach(item=>{item.mark='kept';});sendFailure={kind:'other',code:String(result.status),why:result.message||String(result.status)};emit();return;}
   if(result&&result.messageId!==undefined)for(const item of list)item.messageId=result.messageId;emit();
  },error=>{list.forEach(item=>{item.mark='kept';});sendFailure=parseFailure(error);emit();});
 };
 function fail(next){clearTimers();stuck=false;state='failed';failure=next;messages.forEach(item=>{if(item.mark==='starting')item.mark='kept';});emit();}
 function startTimers(){
  slowTimer=clock.setTimeout(()=>{slowTimer=null;if(state==='starting'){state='slow';emit();}},timers.slowMs);
  armFail();
 }
 function armFail(){failTimer=clock.setTimeout(()=>{failTimer=null;if(starting())fail({kind:'timeout',code:'timeout'});},timers.failMs);}
 // A live lead row after a launch settled (or after a failure) joins the page: the launch prompt counts as delivered unless promptDelivered is false, then the outbox flushes in order.
 function tryJoin(){
  const row=live();
  if(!row||!['starting','slow','failed'].includes(state)||(state!=='failed'&&!settled))return false;
  clearTimers();stuck=false;
  const first=messages.filter(item=>item.mark==='starting'||item.mark==='kept'),held=outbox.splice(0);
  state='joined';failure=null;
  if(first.length){if(launchResult&&launchResult.promptDelivered!==false)first.forEach(item=>{item.mark='sent';item.busyAtSend=false;});else deliver(first,row.handle);}
  for(const item of held)deliver([item],row.handle);
  emit();return true;
 }
 // The launched row after a settle or a push: a dead one fails the launch before any join (the dead check comes first) unless it was already dead when the launch started, a startup-stuck one holds it and stops the timers, a vanished one re-arms failMs. Returns true when the state changed.
 function inspect(){
  const row=launchedRow();
  // A relaunch can resolve with an id whose dead row was already in the roster when this launch started: that row is not this launch's death until the roster shows a change for the id (it goes live, or disappears and comes back dead).
  if(launchResult&&staleDead.has(launchResult.sessionId)&&!(row&&died(row)))staleDead.delete(launchResult.sessionId);
  if(starting()&&settled&&row&&died(row)&&!staleDead.has(row.sessionId)){
   fail({kind:'exited',code:row.endReason||(row.effectiveStatus==='crashed'?'crashed':'exited')});return true;
  }
  if(tryJoin())return true;
  if(starting()&&settled){
   if(row&&row.needsYouKind==='startup'){if(!stuck){stuck=true;clearTimers();emit();}}
   else if(stuck){stuck=false;if(!row)armFail();emit();}
  }
  return false;
 }
 function startLaunch(list){
  const mine=++seq;state='starting';failure=null;sendFailure=null;settled=false;stuck=false;launchResult=null;
  staleDead=new Set(peerRows().filter(died).map(row=>row.sessionId));
  list.forEach(item=>{item.mark='starting';});emit();
  return enqueue(()=>Promise.resolve().then(()=>transport.launch(card(texts(list))))).then(result=>{
   if(mine!==seq)return;launchResult=result||{};settled=true;
   if(!inspect()){if(!stuck)startTimers();emit();}
  },error=>{if(mine!==seq)return;settled=true;fail(parseFailure(error));});
 }
 const retryList=()=>[...messages.filter(item=>item.mark==='kept'),...outbox.splice(0)];
 return {
  get state(){return state;},get failure(){return failure;},get stuck(){return stuck;},get sendFailure(){return sendFailure;},get messages(){return messages;},get held(){return outbox.length;},
  hasHeld:()=>outbox.length>0,
  // Enter or Send. Typing, focus and Shift+Enter never reach here.
  send(text){
   const item={id:++ids,text,mark:null,sentAt:clock.now()};messages.push(item);
   const row=live();
   if(state==='failed'){
    if(row){tryJoin();return deliver([item],row.handle);}
    return startLaunch([...retryList(),item]);
   }
   if(starting()){item.mark='held';outbox.push(item);emit();return Promise.resolve();}
   if(row)return deliver([...messages.filter(other=>other!==item&&other.mark==='kept'),item],row.handle);
   if(queue)return deliver([...messages.filter(other=>other!==item&&other.mark==='kept'),item],queue);
   // With the lead gone, text kept from a failed send rides along with the new launch.
   return startLaunch([...messages.filter(other=>other!==item&&other.mark==='kept'),item]);
  },
  // Launch from the header, with no message of its own: kept text rides along as it does on a send. A live or starting lead needs nothing.
  start(){
   if(live()||starting())return Promise.resolve();
   return startLaunch(retryList());
  },
  // Retry after a failure: a live lead row first (send instead), else one new launch with the kept text.
  retry(){
   if(state!=='failed')return Promise.resolve();
   if(live()){tryJoin();return Promise.resolve();}
   return startLaunch(retryList());
  },
  // After a failed sendAsHuman: send the kept messages again.
  retrySend(){
   const row=live(),kept=messages.filter(item=>item.mark==='kept');
   if(!kept.length||state==='failed')return Promise.resolve();
   return row?deliver(kept,row.handle):queue?deliver(kept,queue):startLaunch(kept);
  },
  // The sessions() roster changed.
  rows(next){
   rows=Array.isArray(next)?next:[];
   if(inspect())return;
   if(state==='joined'&&!live())state='idle';
   emit();
  },
  dispose(){seq++;clearTimers();},
 };
}
