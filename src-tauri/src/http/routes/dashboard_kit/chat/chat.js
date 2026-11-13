// SPDX-License-Identifier: MIT
// kit.chat.mount(el, {transport, reads, layout, cards, headerSlot, chips, ...}): the one chat DOM. A later story extends this (Group chat); a page never builds a second chat.
// The peer is {storyId, leadRole} (the roster rows of that story's role) or an own target; timers {slowMs, failMs} bound a launch; card(text) builds the launch prompt.
// A page with another peer or another frame passes options, never a second chat (the sprint page's, src/sprint/chat.js):
//  target: {rows(sessions)->peer rows, read(peerRows, transport)->Promise<thread lists>, queue, follow, leadName(row)}: who the peer is, what its thread reads, where a message goes while no peer runs (queue, instead of a launch) and whether the thread moves when the peer does (follow).
//  headerSlot: {slot, render(state)->{sig,nodes}}: the peer's controls, painted into the page's own header slot.
//  layout: {head(state)->{sig,nodes}, source, composer(state)->{placeholder,hint,send}, composerRows, composerLabel, logLabel, empty, autofocus}: the words and the rows above the log; source is the plain line shown there when there is no head.
//  cards: {parse(text)->card|null} replaces chat-core's parser; false turns inline cards off (a needs-you row reads as a message).
//  chips: [{label, text}]: one-tap messages above the composer, sent like typed text.
// state is {lead, fail(what,text), clear(what)}; fail puts a role=alert row in the thread's status slot.
import {h} from './dom.js';
import {CHAT_COPY,failureText,modelLabel,timeLabel} from './copy.js';
import {createLaunch,parseFailure} from './launch.js';
import {activityOf,leadRowsOf,liveLeadOf,presenceOf} from './presence.js';
import {mergeThread,newestFrom,sideOf} from './thread.js';
import {createComposer} from './composer.js';
import {pinToBottom} from './pin.js';
import {cardAnswer,deliveryMark,parseCard} from './chat-core.js';
import {cardNode} from './card.js';
const systemClock=()=>({now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)});
// Faces carry their words next to them (the header line, the row text), so they are hidden from assistive tech; data-label keeps the same words for tests.
const face=(state,label)=>h('span',{class:'av','aria-hidden':'true','data-face':state,'data-label':label});
const ALERT_NS='http://www.w3.org/2000/svg';
const alertIcon=()=>{const svg=document.createElementNS(ALERT_NS,'svg'),path=document.createElementNS(ALERT_NS,'path');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('class','ico alert');svg.setAttribute('aria-hidden','true');path.setAttribute('d','M8 2l6.5 11.5h-13zM8 6.5v3.5M8 11.8v.2');svg.append(path);return svg;};
// Keyed reconcile: an item whose signature is unchanged keeps its node, and a node already at its position is not moved, so focus and a role=alert announcement survive a render. Items carry {id,sig,make} or a fixed {id,node}.
function reconcile(parent,cache,items){
 const seen=new Set(),nodes=[];
 for(const item of items){
  seen.add(item.id);
  if(item.node){nodes.push(item.node);continue;}
  const old=cache.get(item.id);
  if(old&&old.sig===item.sig)nodes.push(old.node);else{const node=item.make();cache.set(item.id,{sig:item.sig,node});nodes.push(node);}
 }
 for(const id of [...cache.keys()])if(!seen.has(id))cache.delete(id);
 nodes.forEach((node,index)=>{if(parent.childNodes[index]!==node)parent.insertBefore(node,parent.childNodes[index]||null);});
 while(parent.childNodes.length>nodes.length)parent.lastChild.remove();
}
const markText={stuck:CHAT_COPY.mark.stuck,starting:CHAT_COPY.mark.starting,held:CHAT_COPY.mark.held,sent:CHAT_COPY.mark.sent,queued:CHAT_COPY.mark.queued,delivered:CHAT_COPY.mark.delivered,kept:CHAT_COPY.mark.kept};
const storyTarget=(storyId,leadRole)=>({
 rows:sessions=>leadRowsOf(sessions,storyId,leadRole),
 read:(peers,transport)=>Promise.all([...peers.map(row=>transport.threadOf(row.sessionId).catch(()=>[])),transport.roleThread().catch(()=>[])]),
 queue:null,follow:false,leadName:()=>CHAT_COPY.lead,
});
const DEFAULT_TIMERS={slowMs:20000,failMs:120000};
export function mount(el,{storyId=null,leadRole=null,transport,reads,timers=DEFAULT_TIMERS,card=text=>text,clock=systemClock(),done=false,win=window,target:own=null,headerSlot=null,layout={},cards={},chips=[]}){
 const target=own||storyTarget(storyId,leadRole),parseOf=cards&&cards.parse||parseCard;
 // Cards answered from this page: id -> {phase:'pending'|'error'|'answered', text, at, failure}. An answer sent from the Inbox is read from the thread instead (chat-core cardAnswer).
 const cardState=new Map(),drafts=new Map();
 let refocusCard=null;
 let started=false,firstRead=Promise.resolve(),rows=[],thread=[],model=null,joinedAt=null,runningSince=0,lastLiveState=null,launchSessionId=null,isDone=done,awaitBase=null,gen=0,refocus=false;
 const streams=new Map(),watched=new Set(),listeners=new Set(),cache=new Map();
 const fails=new Map();
 const wrapped={launch:async prompt=>{const result=await transport.launch(prompt);if(result&&result.sessionId)launchSessionId=result.sessionId;return result;},send:(handle,text)=>transport.send(handle,text)};
 const launch=createLaunch({transport:wrapped,clock,storyId,leadRole,timers,card,onChange:()=>render(),rowsOf:target.rows,queue:target.queue});
 const live=()=>target.rows(rows).find(row=>row.state!=='exited')||null;
 const leadHandles=()=>new Set(target.rows(rows).map(row=>row.handle));
 const leadCount=()=>{const handles=leadHandles();return thread.filter(row=>sideOf(row,handles)==='lead').length+streams.size;};
 const presence=()=>presenceOf(live(),{launch:{state:launch.state,failure:launch.failure,stuck:launch.stuck},runningSince,done:isDone});
 // A dead or stuck launch points at the launched session first: another lead row can be live to presence (AC 1).
 const launchedFirst=()=>launch.stuck||(launch.state==='failed'&&launch.failure.kind==='exited');
 const terminalTarget=()=>(launchedFirst()&&launchSessionId)||(live()&&live().sessionId)||launchSessionId||null;
 const showTerminal=()=>{const target=terminalTarget();if(target)transport.gotoAgent(target);};
 // --- DOM: the thread is role=log (focusable, so a long thread scrolls by keyboard), the composer is pinned under it.
 const log=h('div',{class:'log',role:'log',tabindex:'0','aria-live':'polite','aria-label':layout.logLabel||'Story lead chat'});
 const pin=pinToBottom(log,{win});
 const status=h('div',{class:'status-slot',id:'sv-status',tabindex:'-1'});
 const composer=createComposer({onSend:text=>{awaitBase=leadCount();fails.clear();launch.send(text);},rows:layout.composerRows,label:layout.composerLabel});
 const headBox=h('div',{class:'chat-head'}),headSig={head:null,header:null};
 const sendChip=text=>{awaitBase=leadCount();fails.clear();launch.send(text);};
 const chipsBox=chips.length?h('div',{class:'chips',role:'group','aria-label':CHAT_COPY.chips},...chips.map(chip=>h('button',{type:'button',class:'btn sm','data-chip':chip.label,onclick:()=>{if(!isDone)sendChip(chip.text);}},chip.label))):null;
 el.replaceChildren(h('div',{class:'chatcol'},layout.head?headBox:layout.source?h('div',{class:'src'},layout.source):null,log,chipsBox,composer.region));
 const state=()=>({lead:live(),fail:(what,text)=>{fails.set(what,text);render();},clear:what=>{if(fails.delete(what))render();}});
 // A slot is repainted only when its signature changes, so focus on its buttons survives a pushed event that changes nothing.
 const paint=(slot,key,made)=>{if(made.sig!==headSig[key]){headSig[key]=made.sig;slot.replaceChildren(...made.nodes);}};
 const bubble=(item,side)=>h('div',{class:`msg ${side}`,'data-mid':item.id===undefined?null:String(item.id)},
  h('div',{class:'meta'},`${item.who} · ${timeLabel(item.at)}`),h('div',{class:'body'},item.text),item.note?h('div',{class:'note'},item.note):null,item.mark?h('div',{class:'mark','data-mark':item.markKey},item.mark):null);
 const typing=()=>h('div',{class:'msg lead typing','data-typing':'1'},face('working',CHAT_COPY.row.typing),h('span',{class:'dots','aria-hidden':'true'},h('i'),h('i'),h('i')),h('span',{class:'sr'},CHAT_COPY.row.typing));
 const termButton=id=>{const on=Boolean(terminalTarget());return h('button',{type:'button',class:'btn sm quiet term',id,'data-term':'1',disabled:on?null:'',onclick:showTerminal},on?CHAT_COPY.terminal:CHAT_COPY.terminalOff);};
 const alertRow=(kind,why,code,...extra)=>h('div',{class:'sys danger',role:'alert','data-row':kind},alertIcon(),h('span',{class:'why'},why),code?h('code',{class:'code'},code):null,...extra);
 // Status rows are reconciled by signature, like the thread: a pushed event that changes nothing leaves the node (focus on its button, the role=alert announcement) alone.
 const statusCache=new Map();
 function statusItems(){
  const state=launch.state,p=presence(),on=Boolean(terminalTarget()),out=[];
  for(const [what,text] of fails)out.push({id:'fail-'+what,sig:'x|'+what+'|'+text,make:()=>{const row=alertRow('act-failed',text,'');row.setAttribute('data-fail',what);return row;}});
  if((state==='starting'||state==='slow')&&launch.stuck){
   out.push({id:'stuck',sig:'stuck|'+on,make:()=>h('div',{class:'sys warn','data-row':'stuck'},h('span',{},CHAT_COPY.row.needsTerminal),termButton('sv-term-stuck'))});
  }else if(state==='starting'||state==='slow'){
   out.push({id:'starting',sig:'s',make:()=>h('div',{class:'sys','data-row':'starting'},face('starting',`${CHAT_COPY.lead} · ${CHAT_COPY.header.starting}`),h('span',{},CHAT_COPY.row.starting))});
   if(state==='slow')out.push({id:'slow',sig:'slow|'+on,make:()=>h('div',{class:'sys warn','data-row':'slow'},h('span',{},CHAT_COPY.row.slow),termButton('sv-term-slow'))});
  }else if(state==='failed'){
   const failure=launch.failure;
   out.push({id:'failed',sig:['f',failure.kind,failure.code,failureText(failure),on].join('|'),make:()=>alertRow('failed',failureText(failure),failure.code,failure.kind==='timeout'||failure.kind==='exited'?termButton('sv-term-failed'):null,
    h('button',{type:'button',class:'btn sm','data-retry':'1',onclick:()=>{refocus=true;launch.retry();status.focus();}},CHAT_COPY.row.retry))});
  }else{
   const sf=launch.sendFailure;
   if(sf)out.push({id:'send-failed',sig:['sf',sf.why,sf.code].join('|'),make:()=>alertRow('send-failed',CHAT_COPY.failure.send(sf.why||sf.code),sf.code,
    h('button',{type:'button',class:'btn sm','data-retry-send':'1',onclick:()=>{launch.retrySend();}},CHAT_COPY.row.retry))});
   if(joinedAt!==null){
    const text=CHAT_COPY.row.joined(model?modelLabel(model):CHAT_COPY.row.modelNone,activityOf(live(),runningSince));
    out.push({id:'joined',sig:['j',p.face,p.header,text].join('|'),make:()=>h('div',{class:'sys','data-row':'joined'},face(p.face,`${CHAT_COPY.lead} · ${p.header}`),h('span',{},text))});
   }
  }
  return out;
 }
 // Thread rows and the messages this page sent, merged by time: the launch message goes in through initialPrompt and never becomes an inbox row, so it sorts by sentAt.
 function answerCard(row,text){
  const id=row.messageId;
  if(cardState.has(id)&&cardState.get(id).phase!=='error')return Promise.resolve();
  refocusCard=id;cardState.set(id,{phase:'pending',text});render();
  return Promise.resolve().then(()=>transport.reply(id,text)).then(result=>{
   if(result&&result.status!==undefined&&result.status!=='sent')throw new Error(result.message||String(result.status));
   cardState.set(id,{phase:'answered',text,at:clock.now()});drafts.delete(id);render();
  },error=>{const failure=parseFailure(error);cardState.set(id,{phase:'error',text,failure:failure.why||failure.code});render();});
 }
 // An inline card for a needs-you message from the lead: open, pending, error or answered (here, or in the Inbox, which the thread tells us).
 function cardEntry(row){
  const id=row.messageId,local=cardState.get(id),remote=cardAnswer(id,thread),text=row.text||row.summary||'',parsed=parseOf(text);
  const state=local&&local.phase==='answered'?'answered':remote?'answered':local?local.phase:'open';
  const answer=state!=='answered'?null:local&&local.phase==='answered'?{text:local.text,at:local.at,where:'here'}:{text:remote.text,at:remote.at,where:'inbox'};
  const failure=state==='error'?local.failure:null;
  return {t:row.createdAtMs||0,id:'m'+id,sig:['c',id,text,state,answer&&answer.text,answer&&answer.where,failure,row.createdAtMs].join('|'),
   make:()=>cardNode({lead:target.leadName(row),id,text,parsed,at:row.createdAtMs,state,answer,failure,draft:drafts.get(id),onAnswer:value=>answerCard(row,value),onDraft:value=>drafts.set(id,value)})};
 }
 // A sent message is Queued or Delivered by chat-core's rule over the lead's row now; the others are the launch machine's own marks.
 function markOfItem(item){
  if(item.mark==='starting'&&launch.stuck)return 'stuck';
  if(item.mark!=='sent')return item.mark;
  return deliveryMark({sentAt:item.sentAt,busyAtSend:item.busyAtSend,lead:live(),newestLeadAt:newestFrom(thread,leadHandles())});
 }
 function threadItems(){
  const handles=leadHandles(),entries=[],rowIds=new Set(thread.map(row=>row.messageId)),sentHere=new Map(launch.messages.filter(item=>item.messageId!==undefined).map(item=>[item.messageId,item]));
  for(const row of thread){
   const side=sideOf(row,handles),needs=cards!==false&&row.kind==='needs-you'&&side==='lead';
   if(needs){entries.push(cardEntry(row));continue;}
   const who=side==='you'?CHAT_COPY.who.you:side==='lead'?target.leadName(row):(row.fromName||row.from||''),own=sentHere.get(row.messageId),mark=own?markOfItem(own):null;
   entries.push({t:row.createdAtMs||0,id:'m'+row.messageId,sig:['m',row.messageId,row.text,side,row.createdAtMs,mark].join('|'),make:()=>bubble({id:row.messageId,text:row.text||row.summary||'',mark:mark&&markText[mark],markKey:mark,who,at:row.createdAtMs},side)});
  }
  for(const item of launch.messages){
   if(item.messageId!==undefined&&rowIds.has(item.messageId))continue;
   const mark=markOfItem(item);
   entries.push({t:item.sentAt,id:'l'+item.id,sig:['l',item.id,mark,item.text].join('|'),make:()=>bubble({text:item.text,mark:markText[mark]||null,markKey:mark,who:CHAT_COPY.who.you,at:item.sentAt},'you')});
  }
  entries.sort((a,b)=>a.t-b.t);
  for(const [id,text] of streams)if(!rowIds.has(id))entries.push({t:Infinity,id:'s'+id,sig:'s|'+id+'|'+text,make:()=>bubble({id,text,who:CHAT_COPY.lead,at:clock.now()},'lead')});
  return entries;
 }
 const awaiting=()=>awaitBase!==null&&leadCount()<=awaitBase&&(launch.state==='joined'||Boolean(live()&&live().state==='running'));
 function render(){
  const p=presence();
  if(launch.state==='joined'&&joinedAt===null){
   joinedAt=clock.now();const row=live();
   // The model comes from sessionUsage for this lead's own session; the usage row's sessionId is the CLI's id, so rows are never joined by id.
   if(row)reads.usage({sessionId:row.sessionId}).then(usage=>{const own=usage&&usage.sessions&&usage.sessions[0],first=own&&own.models&&own.models[0];model=(typeof first==='string'?first:first&&first.model)||null;render();},()=>{});
  }
  if(launch.state!=='joined'&&launch.state!=='idle')joinedAt=null;
  reconcile(status,statusCache,statusItems());
  status.hidden=!status.childNodes.length;
  const here=state();
  if(layout.head)paint(headBox,'head',layout.head(here));
  if(headerSlot)paint(headerSlot.slot,'header',headerSlot.render(here));
  const want=[...(layout.empty&&!thread.length&&!launch.messages.length?[{id:'empty',sig:'e',make:()=>h('div',{class:'empty'},layout.empty)}]:[]),...threadItems(),{id:'status',node:status},...(awaiting()?[{id:'typing',sig:'t',make:typing}]:[])];
  reconcile(log,cache,want);
  pin.onContentChanged();
  // The button that sent is gone once the card answers: focus follows to its answered line.
  if(refocusCard!==null){const done=log.querySelector(`[data-card="${refocusCard}"][data-state=answered] .chosen`);if(done){done.focus();refocusCard=null;}}
  if(refocus&&launch.state!=='starting'&&launch.state!=='slow'){refocus=false;const retry=status.querySelector('[data-retry]');if(retry&&(!el.ownerDocument.activeElement||el.ownerDocument.activeElement===el.ownerDocument.body||el.ownerDocument.activeElement===status))retry.focus();}
  composer.update({placeholder:p.placeholder,disabled:isDone,...(layout.composer?layout.composer(here):{})});
  for(const fn of listeners)fn();
 }
 // --- data: the thread is inbox({sessionId}) for each lead row of this story plus the role queue, merged (AC8).
 async function readThread(){
  const mine=++gen,peers=target.rows(rows);
  for(const row of peers)watched.add(row.sessionId);
  let lists;
  try{lists=await target.read(peers,transport);}catch(error){if(mine===gen){fails.set('thread',(error&&error.message)||String(error));render();}return;}
  if(mine!==gen)return;
  fails.delete('thread');
  thread=mergeThread(...lists);
  if(runningSince===0)runningSince=newestFrom(thread,leadHandles());
  for(const row of thread)streams.delete(row.messageId);
  if(awaitBase!==null&&leadCount()>awaitBase)awaitBase=null;
  render();
 }
 function onRows(next){
  const before=live();rows=next;const now=live();
  if(now&&now.state==='running'&&(!before||before.state!=='running')&&lastLiveState!==null)runningSince=clock.now();
  lastLiveState=now?now.state:'none';
  launch.rows(next);
  const moved=target.follow&&(before&&before.handle)!==(now&&now.handle);
  if(moved)pin.reset();
  if(!started||moved||target.rows(next).some(row=>!watched.has(row.sessionId))){const read=readThread();if(!started)firstRead=read;started=true;}else render();
 }
 const offs=[reads.on('sessions',()=>onRows(reads.latestSessions())),reads.on('inbox',()=>{readThread();}),reads.on('activity',()=>render())];
 if(typeof transport.stream==='function')offs.push(transport.stream(chunk=>{streams.set(chunk.messageId,(streams.get(chunk.messageId)||'')+chunk.text);render();}));
 const onUnload=event=>{if(launch.hasHeld()){event.preventDefault();event.returnValue=CHAT_COPY.unload;return CHAT_COPY.unload;}};
 win.addEventListener('beforeunload',onUnload);
 render();
 if(layout.autofocus!==false)composer.input.focus();
 reads.sessions();
 return {
  unmount(){offs.forEach(off=>off&&off());pin.release();launch.dispose();win.removeEventListener('beforeunload',onUnload);el.replaceChildren();},
  // The header's lead controls: which are on, and what each does (the page's inline confirm comes first).
  controls:()=>({launch:!isDone&&!live()&&launch.state!=='starting'&&launch.state!=='slow',focus:Boolean(terminalTarget()),stop:Boolean(live()),done:isDone}),
  launchLead:()=>launch.start(),
  focusLead:()=>{const target=terminalTarget();return target?Promise.resolve(transport.gotoAgent(target)):Promise.reject(new Error('not running'));},
  stopLead:()=>{const row=live();return row?Promise.resolve(transport.stop(row.handle)):Promise.reject(new Error('not running'));},
  // The first thread read, once the first roster is in: a page that paints around the chat waits on it. refresh() re-reads the thread.
  loaded:()=>reads.sessions().then(()=>firstRead),refresh:()=>readThread(),
  presence,launch,showTerminal,thread:()=>thread,leadHandles,terminalOn:()=>Boolean(terminalTarget()),lead:live,
  setDone(value){isDone=Boolean(value);render();},
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
 };
}
