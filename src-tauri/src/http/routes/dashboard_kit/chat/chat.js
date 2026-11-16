// SPDX-License-Identifier: MIT
// kit.chat.mount(el, {transport, reads, layout, cards, headerSlot, chips, ...}): the one chat DOM. A page never builds a second chat.
// The peer is {storyId, leadRole} (the roster rows of that story's role) or an own target; timers {slowMs, failMs} bound a launch; card(text) builds the launch prompt.
// A page with another peer or another frame passes options, never a second chat:
//  target: {rows(sessions)->peer rows, read(peerRows, transport)->Promise<thread lists>, queue, follow, leadName(row)}: who the peer is, what its thread reads, where a message goes while no peer runs (queue, instead of a launch) and whether the thread moves when the peer does (follow).
//  headerSlot: {slot, render(state)->{sig,nodes}}: the peer's controls, painted into the page's own header slot.
//  layout: {head(state)->{sig,nodes}, source, composer(state)->{placeholder,hint,send,label}, composerRows, composerLabel, logLabel, empty, autofocus}: the words and the rows above the log; source is the plain line shown there when there is no head. variant:'page' marks the column (data-variant, class page) for a full-page layout.
//   label names the input while composer(state) gives it (a recipient's name), else composerLabel. composerSlot(el)->release: the page's own control in the composer, above the box (a "To" chip), mounted once; release runs on unmount. A filled slot grows the composer past its 96px; an empty one takes no room.
//  activity: true|{text(state)->line|null}: the working row under the thread, off by default (the page's line, else the live lead's prose from the host's onSessionText, else the peer's current step while it runs, else Working…).
//  cards: {parse(text)->card|null} replaces chat-core's parser; false turns inline cards off (a needs-you row reads as a message). consent:true reads the card line that ends a card's text (chat-core parseCardLine) into its buttons, its consent class in the header and data-step/data-act; the line is not shown. Off by default.
//  chips: [{label, text, edit}]: one-tap messages above the composer, sent like typed text; edit adds a pencil that puts the text in the composer instead.
//  faces: true|(row)->{src|face,name,label}: opt-in avatars. A lead's or another agent's message shows its sender's avatar at the start of a run (src draws that image, face or a name goes to kit.avatar, true draws initials from the sender's name), and a run of messages from one sender is one meta line (label is the name on it, else the sender's name); the person's own messages carry no avatar. Unset, the thread is unchanged.
//  next: true|{edit}: the lead's trailing `Next:` line (chat-core parseNext) becomes chips after its newest message and is left out of the message's text; edit adds each chip's pencil. Off by default.
//  send: a send state (createSendState, send-state.js) the page keeps across mounts: the launch with its messages, outbox and timers, and the cards answered from this page. The mount attaches to it and detaches on unmount; without it the mount makes one and ends it on unmount.
//  copy: the page's own words over CHAT_COPY, one level deep (a section it names keeps the keys it leaves out).
//  target also takes, all off by default:
//   pick(peerRows)->row: the live row, for presence and for the row a send goes to (default: the first that has not exited, and for a send the first that is joinable).
//   handles(peerRows)->[handle]: more handles whose messages are the peer's side of the thread (an older peer's).
//   sources(peerRows)->[id]: the mailboxes the thread reads, one read each (transport.threadOf(id), plus the role queue), instead of read(); a source that fails never hides the rest, and the thread says so (unread, stale rows).
//   bindLaunched, keepUnsent: the launch's rules (launch.js).
//   recipient()->{handle,name}|null: read at each send. A recipient takes the message straight to its handle (launch.sendTo), never through the launch; its bubble says "To <name>" in its meta line. Null is the peer, as without it.
// The mount returns post(text) (a message from another control, true when it went), threadFailed(), threadSettled(), refresh(onlyNew), which reads again (only the sources not read yet), and repaint() after the page's own state changes (a recipient picked).
// state is {lead, fail(what,text), clear(what)}; fail puts a role=alert row in the thread's status slot.
import {h} from './dom.js';
import {CHAT_COPY,failureText,mergeCopy,modelLabel,timeLabel} from './copy.js';
import {joinable,parseFailure} from './launch.js';
import {DEFAULT_TIMERS,createSendState,systemClock} from './send-state.js';
import {activityOf,leadRowsOf,liveOf,presenceOf} from './presence.js';
import {createProse} from './prose.js';
import {mergeThread,newestFrom,sideOf} from './thread.js';
import {createSources} from './sources.js';
import {createComposer} from './composer.js';
import {pinToBottom} from './pin.js';
import {rovingThread} from './roving.js';
import {linkChatStyles,mountIds}from './mount-ids.js';
import {cardAnswer,createMarkLatch,parseCard,parseCardLine,parseNext,PIN_CAP,pinCapLabel,pinCapNote,pinLiveText,pinReplaceLabel,htmlNameOf,pinTitleOf,pinWho} from './chat-core.js';
import {createPinReplace} from './pin-replace.js';
import {cardNode} from './card.js';
import {inlineNodes} from './inline.js';
// Faces carry their words next to them (the header line, the row text), so they are hidden from assistive tech; data-label keeps the same words for tests.
// A sender's avatar for the faces option: an image by src, else kit.avatar (a face ref or initials from the name); a page without kit.avatar gets the initials in a plain span.
const initialsOf=name=>{const parts=String(name||'?').split(/[\s_-]+/).filter(Boolean);return(parts.length>1?parts[0][0]+parts[1][0]:(parts[0]||'?').slice(0,2)).toUpperCase();};
function avatarOf(info){
 const kit=window.codesense&&window.codesense.kit;
 if(kit&&typeof kit.avatar==='function')return kit.avatar({face:info.face,name:info.name,size:24});
 return h('span',{class:'cs-avatar',title:info.name},initialsOf(info.name));
}
// An image that fails to load (a dead src) is swapped for the face kit.avatar draws, or the initials without it, so the run never shows a broken image.
// The face sits beside the meta line, which already names the sender, so it is hidden from assistive tech (its initials or alt would read the name twice).
const unspoken=node=>{node.setAttribute('aria-hidden','true');return node;};
function faceNode(info){
 if(!info.src)return unspoken(avatarOf(info));
 const img=h('img',{src:info.src,alt:''}),wrap=unspoken(h('span',{class:'cs-avatar',title:info.name},img));
 img.addEventListener('error',()=>{const next=unspoken(avatarOf(info));if(wrap.parentNode)wrap.replaceWith(next);else wrap.replaceChildren(next);},{once:true});
 return wrap;
}
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
export const storyTarget=(storyId,leadRole)=>({
 rows:sessions=>leadRowsOf(sessions,storyId,leadRole),
 read:(peers,transport)=>Promise.all([...peers.map(row=>transport.threadOf(row.sessionId).catch(()=>[])),transport.roleThread().catch(()=>[])]),
 queue:null,follow:false,leadName:()=>CHAT_COPY.lead,
});
// The peer a chat talks to: the page's own target, else the story's lead rows. A page that makes the send state itself resolves its target the same way.
export const targetOf=({target=null,storyId=null,leadRole=null})=>target||storyTarget(storyId,leadRole);
export function mount(el,{storyId=null,leadRole=null,transport,reads,timers=DEFAULT_TIMERS,card=text=>text,clock=systemClock(),done=false,win=window,target:own=null,headerSlot=null,layout={},cards={},chips=[],faces=null,next=false,activity=false,copy:words=null,styles=true,onPin=null,html=null,send:sendOpt=null}){
 const mountSlot=mountIds(win.document,el),ids=mountSlot.ids;
 if(styles)linkChatStyles(win.document);
 const target=targetOf({target:own,storyId,leadRole}),parseOf=cards&&cards.parse||parseCard,consentOn=Boolean(cards&&cards.consent),copy=words?mergeCopy(words):CHAT_COPY;
 // The send state (send-state.js): the launch with its messages, outbox and timers, and the cards answered from this page (id -> {phase:'pending'|'error'|'answered', text, at, failure}; an answer sent from the Inbox is read from the thread instead, chat-core cardAnswer).
 // A page that keeps the send state across a hide hands it in (send); without it this mount makes one and ends it on unmount.
 const send=sendOpt||createSendState({transport,reads,clock,timers,card,target,storyId,leadRole,win,copy:words}),launch=send.launch,cardState=send.cards,drafts=new Map();
 let refocusCard=null;
 let gone=false,started=false,gotRows=false,firstRead=Promise.resolve(),rows=[],thread=[],model=null,joinedAt=null,runningSince=0,lastLiveState=null,isDone=done,awaitBase=null,gen=0,refocus=false;
 const streams=new Map(),watched=new Set(),listeners=new Set(),cache=new Map();
 const fails=new Map();
 // The thread has been read once: until then an empty thread is unknown, not empty.
 let threadRead=false;
 // The live row for presence: the launched row while it can be joined (bindLaunched), else the page's rule over the peer rows.
 const live=()=>{const own=target.bindLaunched?launch.launchedIn(rows):null;return joinable(own)?own:(target.pick||liveOf)(target.rows(rows));};
 const leadHandles=()=>new Set([...target.rows(rows).map(row=>row.handle),...(target.handles?target.handles(target.rows(rows)):[])]);
 // target.sources: the thread is read by source, each on its own.
 const sources=target.sources?createSources({transport,clock,peers:()=>target.rows(rows),sourcesOf:target.sources}):null;
 const leadCount=()=>{const handles=leadHandles();return thread.filter(row=>sideOf(row,handles)==='lead').length+streams.size;};
 const presence=()=>presenceOf(live(),{launch:{state:launch.state,failure:launch.failure,stuck:launch.stuck},runningSince,done:isDone},copy);
 // A dead or stuck launch points at the launched session first: another lead row can be live to presence.
 const launchedFirst=()=>launch.stuck||(launch.state==='failed'&&launch.failure.kind==='exited');
 const terminalTarget=()=>(launchedFirst()&&launch.sessionId())||(live()&&live().sessionId)||launch.sessionId()||null;
 const showTerminal=()=>{const target=terminalTarget();if(target)transport.gotoAgent(target);};
 // --- DOM: the thread is role=log (focusable, so a long thread scrolls by keyboard), the composer is pinned under it.
 const log=h('div',{class:'log',role:'log',tabindex:'0','aria-live':'polite','aria-label':layout.logLabel||copy.logLabel});
 // The working row (activity) sits at the thread's foot, after the log and outside its live region.
 const actFoot=activity?h('div',{class:'act-foot'}):null,actCache=new Map();
 // onPin: the person pins a message into its agent thread, through the page: {pins() -> [{messageId, pinnedBy}], change(action 'pin'|'unpin'|'restore', messageId) -> the new list (rejects on failure), subscribe?(fn) -> off, showPins?(), name?(pinnedBy)}.
 // The cap is shared with the agent: at the cap every Pin is dimmed ahead of time and a click says whose pins fill the list; nothing is replaced. An unpin offers Undo until the next pin, unpin or Esc. No timers.
 const pinCopy=copy.pin||CHAT_COPY.pin,pinState={note:null,busy:null,refocus:null};
 const pinLive=onPin?h('div',{class:'pin-live',role:'status','aria-live':'polite'}):null;
 const pinList=()=>(onPin&&typeof onPin.pins==='function'&&onPin.pins())||[];
 const pinName=by=>onPin&&typeof onPin.name==='function'?onPin.name(by):by;
 // A pin is named as its message (chat-core's rule): an HTML one by its summary, title or heading, never its markup.
 const pinTitle=item=>pinTitleOf({text:item.said||item.text,contentType:item.contentType,summary:item.summary},item.who);
 const capNoteOn=item=>{const text=pinCapNote(pinList(),pinName);pinState.note={mid:item.id,kind:'cap',text};pinLive.textContent=text;};
 async function pinChange(item,action){
  if(pinState.busy!==null)return;
  if(replacer)replacer.closeFor(item.id);
  pinState.busy=item.id;pinState.refocus=item.id;render();
  try{
   const list=await onPin.change(action,item.id);
   const done=action==='pin'?'pinned':action==='unpin'?'unpinned':'restored';
   pinLive.textContent=pinLiveText(done,pinTitle(item),(list||pinList()).length);
   pinState.note=action==='unpin'?{mid:item.id,kind:'undo',item}:null;
  }catch(error){
   // An Undo the engine refuses because the list filled meanwhile says so, as a Pin at the cap does; a retry could not succeed.
   if(action==='restore'&&/at most \d+ pins/.test(String(error&&error.message||error)))capNoteOn(item);
   else pinState.note={mid:item.id,kind:action==='unpin'?'unpin-failed':'failed',item,action};
  }
  // The button flips where it was clicked and keeps focus, so Unpin is one key away.
  pinState.busy=null;pinState.refocus=item.id;render();
 }
 function pinToggle(item){
  const pins=pinList(),pinned=pins.some(p=>p.messageId===item.id);
  if(pinned)return pinChange(item,'unpin');
  if(pins.length>=PIN_CAP){if(replacer)return replacer.toggle(item);capNoteOn(item);pinState.refocus=item.id;render();return;}
  return pinChange(item,'pin');
 }
 // onPin.replace: at the cap, Pin… opens a chooser of which pin to replace, under the message (pin-replace.js). A pin is named as the page's pins name it (onPin.title), else by its
 // preview's name, else as its message; one with no preview is the person's own, drawn as a quote or, for an HTML message, a dashboard.
 const threadRow=id=>thread.find(row=>row.messageId===id);
 const pinTitleOfPin=pin=>{const named=typeof onPin.title==='function'&&onPin.title(pin);if(named)return named;if(pin.preview&&pin.preview.shortName)return pin.preview.shortName;const row=threadRow(pin.messageId);return row?pinTitleOf(row,row.fromName||row.from||''):String(pin.messageId);};
 const chooserId=mid=>`${ids.status}-pin-chooser-${mid}`;
 const replacer=onPin&&onPin.replace?createPinReplace({onPin,state:pinState,live:pinLive,list:pinList,nameOf:pinName,titleOf:pinTitleOfPin,ownOf:pin=>{const row=threadRow(pin.messageId);return row&&row.contentType==='html'?'name':'quote';},idOf:chooserId,copy:pinCopy,render:()=>render(),pinNow:item=>pinChange(item,'pin')}):null;
 // A message's Pin, its tag and its note; the signature changes when any of them does, so the bubble is rebuilt only then.
 function pinParts(item){
  if(!onPin||item.id===undefined||item.id===null)return null;
  const pins=pinList(),pin=pins.find(p=>p.messageId===item.id),atCap=!pin&&pins.length>=PIN_CAP,note=pinState.note&&pinState.note.mid===item.id?pinState.note:null;
  // An open chooser stays when a pin leaves and there's room: it offers a plain Pin.
  const more=Boolean(atCap&&replacer),choosing=Boolean(replacer&&replacer.isOpen(item.id));
  const label=pin?pinCopy.unpin:more?pinReplaceLabel(pins.length):atCap?`${pinCopy.pin} (${pinCapLabel(pins.length)})`:pinCopy.pin,busy=pinState.busy===item.id;
  const sig=['p',pin?pin.pinnedBy:'',atCap,busy,note?note.kind+(note.text||''):'',more?pins.length:'',choosing].join(':');
  const make=()=>{
   const button=h('button',{type:'button',class:'pin-b','aria-label':label,'aria-pressed':pin?'true':'false','aria-disabled':(atCap&&!more)||busy?'true':null,'aria-expanded':more||choosing?String(choosing):null,'aria-controls':choosing?chooserId(item.id):null,title:label,'data-pin':pin?'pinned':atCap?'cap':'pin','data-pin-mid':String(item.id),onclick:()=>pinToggle(item)},
    pin?pinCopy.unpin:more?[pinCopy.pinMore,h('span',{class:'pin-cap','aria-hidden':'true'},String(pins.length))]:pinCopy.pin);
   const acts=h('div',{class:'pin-acts',role:'group','aria-label':pinCopy.actions},button);
   const tag=pin?h('div',{class:'pin-tag'},pinCopy.by(pinWho(pin.pinnedBy,pinName))):null;
   let foot=replacer&&note?replacer.foot(note):null;
   if(foot);else if(note&&note.kind==='cap')foot=h('div',{class:'pin-note',role:'note'},h('span',{},note.text),h('button',{type:'button',class:'btn sm',onclick:()=>{pinState.note=null;render();if(typeof onPin.showPins==='function')onPin.showPins();}},pinCopy.showPins));
   else if(note&&note.kind==='undo')foot=h('div',{class:'pin-note',role:'note'},h('span',{},pinCopy.unpinned),h('button',{type:'button',class:'btn sm',onclick:()=>{if(pinList().length>=PIN_CAP){capNoteOn(note.item);render();}else pinChange(note.item,'restore');}},pinCopy.undo));
   else if(note)foot=h('div',{class:'pin-note danger',role:'alert'},h('span',{},note.kind==='unpin-failed'?pinCopy.unpinFailed:pinCopy.failed),h('button',{type:'button',class:'btn sm',onclick:()=>pinChange(note.item,note.kind==='unpin-failed'?'unpin':note.action||'pin')},pinCopy.tryAgain));
   return {acts,tag,foot:[choosing?replacer.node(item):null,foot],pinned:Boolean(pin)};
  };
  return {sig,make};
 }
 if(onPin)log.addEventListener('keydown',event=>{if(event.key==='Escape'&&pinState.note){pinState.note=null;render();}});
 const pin=pinToBottom(log,{win});
 // The thread is one Tab stop: its active message (the newest, until the person moves), with Up, Down, Home and End between messages.
 const roving=rovingThread(log);
 const status=h('div',{class:'status-slot',id:ids.status,tabindex:'-1'});
 // A send to the peer. A Next-line chip always goes here: it is the peer's own suggested reply, whoever the page's recipient is.
 const sendPeer=text=>{fails.clear();awaitBase=leadCount();launch.send(text);return undefined;};
 // A send from the box, a page chip or post: to the page's recipient when it names one (the promise tells the composer whether it went), else to the peer.
 const sendText=text=>{
  const to=target.recipient?target.recipient():null;
  if(!to)return sendPeer(text);
  fails.clear();
  return launch.sendTo(to,text).then(()=>true,failure=>{fails.set('send',copy.failure.send(failure.why||failure.code));render();return false;});
 };
 const composer=createComposer({ids,onSend:sendText,rows:layout.composerRows,label:layout.composerLabel==null?copy.composerLabel:layout.composerLabel,hint:copy.hint,send:copy.send});
 const headBox=h('div',{class:'chat-head'}),headSig={head:null,header:null};
 // Chips: the page's own (chips) and, with next, the ones in the lead's newest Next line. A chip's pencil (edit) puts its text in the composer instead of sending it.
 const nextOpt=next?(typeof next==='object'?next:{}):null;
 const pencil=()=>{const svg=document.createElementNS(ALERT_NS,'svg'),path=document.createElementNS(ALERT_NS,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','ico');svg.setAttribute('aria-hidden','true');path.setAttribute('d','M4 20h4L19 9l-4-4L4 16z');svg.append(path);return svg;};
 const chipNode=chip=>{
  const main=h('button',{type:'button',class:'btn sm','data-chip':chip.label,onclick:()=>{if(!isDone)(chip.peer?sendPeer:sendText)(chip.text);}},chip.label);
  return chip.edit?h('span',{class:'pchip'},main,h('button',{type:'button',class:'btn sm ed','data-chip-edit':chip.label,'aria-label':copy.chipEdit.label(chip.label),title:copy.chipEdit.title,onclick:()=>{if(!isDone)composer.setText(chip.text);}},pencil())):main;
 };
 const chipsBox=chips.length||nextOpt?h('div',{class:'chips',role:'group','aria-label':copy.chips}):null,chipSig={v:null};
 const variant=layout.variant==='page'?'page':null;
 // The page's composer slot: its own node above the box, made once, so a repaint never rebuilds the page's control.
 const composerSlot=layout.composerSlot?h('div',{'data-composer-slot':''}):null;
 if(composerSlot)composer.region.insertBefore(composerSlot,composer.region.firstChild);
 el.replaceChildren(h('div',{class:variant?`chatcol cs-chat ${variant}`:'chatcol cs-chat','data-variant':variant},layout.head?headBox:layout.source?h('div',{class:'src'},layout.source):null,log,actFoot,pinLive,chipsBox,composer.region));
 const state=()=>({lead:live(),fail:(what,text)=>{fails.set(what,text);render();},clear:what=>{if(fails.delete(what))render();}});
 // A slot is repainted only when its signature changes, so focus on its buttons survives a pushed event that changes nothing.
 const paint=(slot,key,made)=>{if(made.sig!==headSig[key]){headSig[key]=made.sig;slot.replaceChildren(...made.nodes);}};
 // first/info belong to the faces option: a run's later messages have no meta line, and its first carries the avatar beside it. Unset, first is true and info null, so the node is what it always was.
 // A face name the line doesn't show (a person's name beside a role word) is said once before it, as a sighted reader gets it from the face; one that holds the line's name (an emoji before it, another case) adds nothing. The visible line is unchanged.
 const holds=(name,who)=>String(name).trim().toLowerCase().includes(String(who).trim().toLowerCase());
 const whoLine=(info,who,meta)=>info?h('div',{class:'who'},faceNode(info),holds(info.name,who)?null:h('span',{class:'sr'},`${info.name}, `),meta):meta;
 // An HTML message is a page the chat doesn't draw: it shows by name (summary, <title>, first heading, as a pin names it) and sender, never as its source.
 // A page that can show the message (html.open(message, slot) → release, or a promise of it) gives the bubble an Open: the page fills a slot under the name, and Close, the message leaving
 // the thread or unmount releases it (a release that arrives after Close runs as it arrives). An open that throws leaves the bubble closed. The toggle changes the bubble in place, so a repaint
 // that changes nothing keeps an open frame, and a bubble rebuilt for another reason (a pin) is updated around its body (keepOpen): an iframe that leaves the page reloads.
 const htmlOpen=new Map();
 const htmlRelease=id=>{const open=htmlOpen.get(id);if(!open)return;htmlOpen.delete(id);open.closed=true;open.slot.remove();if(typeof open.release==='function')open.release();};
 const keepOpen=(id,fresh)=>{
  const open=htmlOpen.get(id),old=open&&open.slot.isConnected?open.slot.closest('.msg'):null,body=old&&old.querySelector(':scope > .body'),freshBody=fresh.querySelector(':scope > .body');
  if(!body||!freshBody)return fresh;
  for(const child of [...old.childNodes])if(child!==body)child.remove();
  const kids=[...fresh.childNodes],at=kids.indexOf(freshBody);
  body.before(...kids.slice(0,at));body.after(...kids.slice(at+1));
  for(const {name} of [...old.attributes])if(!fresh.hasAttribute(name))old.removeAttribute(name);
  for(const {name,value} of [...fresh.attributes])old.setAttribute(name,value);
  return old;
 };
 const htmlToggle=(item,title)=>{
  if(!html||typeof html.open!=='function')return null;
  const slotId=ids.htmlSlot(item.id),button=h('button',{type:'button',class:'btn sm quiet html-open','aria-controls':slotId});
  const show=on=>{button.setAttribute('aria-expanded',on?'true':'false');button.textContent=on?copy.row.htmlClose:copy.row.htmlOpen;};
  button.addEventListener('click',()=>{
   if(htmlOpen.has(item.id)){htmlRelease(item.id);show(false);return;}
   const slot=h('div',{class:'html-slot',id:slotId}),open={slot,release:null,closed:false};
   button.parentNode.append(slot);
   let answer;
   try{answer=html.open({messageId:item.id,title,contentType:'html'},slot);}catch{slot.remove();return;}
   htmlOpen.set(item.id,open);
   if(answer&&typeof answer.then==='function')Promise.resolve(answer).then(release=>{if(!open.closed)open.release=release;else if(typeof release==='function')release();},()=>{});
   else open.release=answer;
   show(true);
  });
  show(htmlOpen.has(item.id));
  return button;
 };
 const htmlName=(item,who)=>{
  const from=copy.row.htmlFrom(who),name=htmlNameOf({text:item.said||item.text,summary:item.summary}),open=htmlOpen.get(item.id);
  return [...(name?[h('div',{class:'html-t'},name),h('div',{class:'html-from'},from)]:[from]),htmlToggle(item,name||from),open&&!open.slot.isConnected?open.slot:null];
 };
 const bubble=(item,side,first=true,info=null)=>{
  const pin=item.pin?item.pin.make():null,who=info&&info.label||item.who;
  const node=h('div',{class:`msg ${side}${pin&&pin.pinned?' pinned':''}`,'data-mid':item.id===undefined?null:String(item.id),'data-run':faces?(first?'start':'cont'):null},
   first?whoLine(info,who,h('div',{class:'meta'},`${who} · ${timeLabel(item.at)}`,item.label?h('span',{'data-row-label':''},` · ${item.label}`):null)):null,pin?pin.acts:null,item.contentType==='html'?h('div',{class:'body','data-html':'1'},htmlName(item,who)):h('div',{class:'body'},inlineNodes(item.text)),item.note?h('div',{class:'note'},item.note):null,item.mark?h('div',{class:'mark','data-mark':item.markKey},item.mark):null,pin?pin.tag:null,pin?pin.foot:null);
  return item.contentType==='html'&&htmlOpen.has(item.id)?keepOpen(item.id,node):node;
 };
 const typing=()=>h('div',{class:'msg lead typing','data-typing':'1'},face('working',copy.row.typing),h('span',{class:'dots','aria-hidden':'true'},h('i'),h('i'),h('i')),h('span',{class:'sr'},copy.row.typing));
 const termButton=id=>{const on=Boolean(terminalTarget());return h('button',{type:'button',class:'btn sm quiet term',id,'data-term':'1',disabled:on?null:'',onclick:showTerminal},on?copy.terminal:copy.terminalOff);};
 const alertRow=(kind,why,code,...extra)=>h('div',{class:'sys danger',role:'alert','data-row':kind},alertIcon(),h('span',{class:'why'},why),code?h('code',{class:'code'},code):null,...extra);
 // Status rows are reconciled by signature, like the thread: a pushed event that changes nothing leaves the node (focus on its button, the role=alert announcement) alone.
 const statusCache=new Map();
 // A page that reads its thread by source (target.sources): history that could not be read says so with Retry; a refresh that failed after a good read says when, so old mail is not taken as current.
 const retry=()=>h('button',{type:'button',class:'btn sm','data-thread-retry':'1',onclick:()=>{readThread();}},copy.row.retry);
 // A page that reads its thread with target.read waits on the roster for its first read: a roster read that failed says so, and Retry asks for it again.
 const rosterRetry=()=>h('button',{type:'button',class:'btn sm','data-thread-retry':'1',onclick:()=>{fails.delete('roster');render();readRoster();}},copy.row.retry);
 const readRows=()=>{
  if(!sources)return [];
  const stale=sources.staleAt();
  if(sources.failedNow())return [{id:'unread',sig:'u',make:()=>alertRow('unread',copy.row.unread,'',retry())}];
  return stale===null?[]:[{id:'stale',sig:'st|'+stale,make:()=>h('div',{class:'sys warn',role:'status','data-row':'stale'},h('span',{},copy.row.stale(timeLabel(stale))),retry())}];
 };
 function statusItems(){
  const state=launch.state,p=presence(),on=Boolean(terminalTarget()),out=[...readRows()];
  for(const [what,text] of fails)out.push({id:'fail-'+what,sig:'x|'+what+'|'+text,make:()=>{const row=alertRow('act-failed',text,'',what==='thread'?retry():what==='roster'?rosterRetry():null);row.setAttribute('data-fail',what);return row;}});
  if((state==='starting'||state==='slow')&&launch.stuck){
   out.push({id:'stuck',sig:'stuck|'+on,make:()=>h('div',{class:'sys warn','data-row':'stuck'},h('span',{},copy.row.needsTerminal),termButton(ids.term('stuck')))});
  }else if(state==='starting'||state==='slow'){
   out.push({id:'starting',sig:'s',make:()=>h('div',{class:'sys','data-row':'starting'},face('starting',`${copy.lead} · ${copy.header.starting}`),h('span',{},copy.row.starting))});
   if(state==='slow')out.push({id:'slow',sig:'slow|'+on,make:()=>h('div',{class:'sys warn','data-row':'slow'},h('span',{},copy.row.slow),termButton(ids.term('slow')))});
  }else if(state==='failed'){
   const failure=launch.failure;
   out.push({id:'failed',sig:['f',failure.kind,failure.code,failureText(failure,copy),on].join('|'),make:()=>alertRow('failed',failureText(failure,copy),failure.code,failure.kind==='timeout'||failure.kind==='exited'?termButton(ids.term('failed')):null,
    h('button',{type:'button',class:'btn sm','data-retry':'1',onclick:()=>{refocus=true;launch.retry();status.focus();}},copy.row.retry))});
  }else{
   const sf=launch.sendFailure;
   if(sf)out.push({id:'send-failed',sig:['sf',sf.why,sf.code].join('|'),make:()=>alertRow('send-failed',copy.failure.send(sf.why||sf.code),sf.code,
    h('button',{type:'button',class:'btn sm','data-retry-send':'1',onclick:()=>{launch.retrySend();}},copy.row.retry))});
   if(joinedAt!==null){
    const text=copy.row.joined(model?modelLabel(model):copy.row.modelNone,activityOf(live(),runningSince,copy));
    out.push({id:'joined',sig:['j',p.face,p.header,text].join('|'),make:()=>h('div',{class:'sys','data-row':'joined'},face(p.face,`${copy.lead} · ${p.header}`),h('span',{},text))});
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
  // With cards.consent on, a card line ending the text (chat-core parseCardLine) is hidden and gives the card's buttons, class and step; a text without one is parsed as before.
  const id=row.messageId,local=cardState.get(id),remote=cardAnswer(id,thread),said=row.text||row.summary||'',line=consentOn?parseCardLine(said):null,text=line?line.text:said;
  const parsed=line?{question:line.text,options:line.acts.map(item=>item.label),pick:null,reason:null,primary:(line.acts.find(item=>item.act!=='none')||{}).label||null}:parseOf(text);
  const state=local&&local.phase==='answered'?'answered':remote?'answered':local?local.phase:'open';
  const answer=state!=='answered'?null:local&&local.phase==='answered'?{text:local.text,at:local.at,where:'here'}:{text:remote.text,at:remote.at,where:'inbox'};
  const failure=state==='error'?local.failure:null;
  return {t:row.createdAtMs||0,id:'m'+id,sig:['c',id,said,state,answer&&answer.text,answer&&answer.where,failure,row.createdAtMs].join('|'),
   make:()=>cardNode({lead:target.leadName(row),id,text,parsed,meta:line,at:row.createdAtMs,state,answer,failure,draft:drafts.get(id),onAnswer:value=>answerCard(row,value),onDraft:value=>drafts.set(id,value)})};
 }
 // A sent message is Queued or Delivered by chat-core's rule over the lead's row now, or by its own messageDelivery row when the page's reads offer one (reads.delivery(messageId)); the others are the launch machine's own marks.
 const deliveryRow=id=>id!==undefined&&typeof reads.delivery==='function'?reads.delivery(id):null;
 const deliveryOf=createMarkLatch();
 function markOfItem(item){
  if(item.mark==='starting'&&launch.stuck)return 'stuck';
  if(item.mark!=='sent')return item.mark;
  // A message to a recipient is read against the recipient's own row and messages, not the peer's.
  const to=item.to?item.to.handle:null,lead=to?rows.find(row=>row.handle===to)||null:live();
  return deliveryOf(item.id,{sentAt:item.sentAt,busyAtSend:item.busyAtSend,lead,newestLeadAt:newestFrom(thread,to?new Set([to]):leadHandles()),delivery:deliveryRow(item.messageId)});
 }
 // The activity row (off unless the page asks): the page's own line (activity.text(state)), else the live lead's prose, else the peer's current step while it runs.
 // The working row sits at the thread's foot, after the log: outside its live region, so a line it shows is never read out with the row. The prose row is one node whose line
 // is updated in place, and its status says Working… once.
 const prose=activity?createProse({win,clock,render:()=>render()}):null;
 let proseRow=null;
 function proseItem(said){
  if(!proseRow)proseRow=h('div',{class:'act','data-row':'activity'},face('working',copy.row.working),h('span',{class:'sr',role:'status','aria-live':'polite'},copy.row.working),h('span',{class:'prose'}));
  const line=proseRow.querySelector('.prose');
  line.textContent=said.line;line.title=said.text;
  return {id:'activity',node:proseRow};
 }
 function activityItem(){
  if(!activity)return null;
  const here=state(),own=activity.text?activity.text(here):null,p=presence();
  prose.follow(live()?live().sessionId:null);
  const said=own?null:prose.current(newestFrom(thread,leadHandles()));
  if(said)return proseItem(said);
  proseRow=null;
  const line=own||(p.key==='running'?(p.activity===copy.header.activityNone?copy.row.working:p.activity):null);
  return line?{id:'activity',sig:'a|'+line,make:()=>h('div',{class:'act',role:'status','aria-live':'polite','data-row':'activity'},face('working',copy.row.working),h('span',{},line))}:null;
 }
 // The Next chips: the lead's newest message, when its last line is a Next line and the person has not sent since (a card is not chips).
 function nextChips(){
  if(!nextOpt)return [];
  const handles=leadHandles();let newest=null,mine=0;
  for(const row of thread){const side=sideOf(row,handles),at=row.createdAtMs||0;if(side==='lead'){if(!newest||at>=newest.at)newest={row,at};}else if(side==='you')mine=Math.max(mine,at);}
  for(const item of launch.messages)mine=Math.max(mine,item.sentAt);
  if(!newest||newest.at<mine||(cards!==false&&newest.row.kind==='needs-you'))return [];
  const parsed=parseNext(newest.row.text||newest.row.summary||'');
  return parsed?parsed.chips.map(text=>({label:text,text,edit:Boolean(nextOpt.edit),peer:true})):[];
 }
 function paintChips(){
  if(!chipsBox)return;
  const seen=new Set(chips.map(chip=>chip.label)),shown=[...nextChips().filter(chip=>!seen.has(chip.label)&&seen.add(chip.label)),...chips];
  const sig=JSON.stringify(shown.map(chip=>[chip.label,chip.text,Boolean(chip.edit)]));
  if(sig!==chipSig.v){chipSig.v=sig;chipsBox.replaceChildren(...shown.map(chipNode));}
  chipsBox.hidden=!shown.length;
 }
 // The faces option for one message: the page's answer for the row, else the sender's name; the person's own messages carry no avatar.
 function faceInfo(row,side,who){
  if(!faces||side==='you')return null;
  const given=typeof faces==='function'?faces(row):null;
  return {name:(given&&given.name)||who,label:given&&given.label||null,src:given&&given.src||null,face:given&&given.face||null};
 }
 // A message sent here to a recipient is labelled from its own send (launch.sendTo records to); under faces, messages to one recipient are one run, so the label is on its meta line.
 const toLabel=item=>item&&item.to?copy.row.to(item.to.name):null;
 const youKey=item=>item&&item.to?'you|'+item.to.handle:'you';
 function threadItems(){
  let lastLead=null;
  const handles=leadHandles(),entries=[],rowIds=new Set(thread.map(row=>row.messageId)),sentHere=new Map(launch.messages.filter(item=>item.messageId!==undefined).map(item=>[item.messageId,item]));
  for(const row of thread){
   const side=sideOf(row,handles),needs=cards!==false&&row.kind==='needs-you'&&side==='lead';
   if(side==='lead')lastLead=row;
   if(needs){entries.push(cardEntry(row));continue;}
   const who=side==='you'?copy.who.you:side==='lead'?target.leadName(row):(row.fromName||row.from||''),own=sentHere.get(row.messageId),mark=own?markOfItem(own):null;
   // With next on, a lead message's Next line is the chips, not part of the text; a message that is only that line shows nothing.
   const said=row.text||row.summary||'',shown=nextOpt&&side==='lead'&&row.text?(parseNext(row.text)||{text:said}).text:said;
   if(nextOpt&&side==='lead'&&row.text&&!shown)continue;
   const label=toLabel(own),item={id:row.messageId,text:shown,said,contentType:row.contentType,summary:row.summary,mark:mark&&copy.mark[mark],markKey:mark,who,at:row.createdAtMs,label},info=faceInfo(row,side,who);
   item.pin=pinParts(item);
   entries.push({t:row.createdAtMs||0,id:'m'+row.messageId,sig:['m',row.messageId,shown,side,row.createdAtMs,mark,label,item.pin?item.pin.sig:''].join('|'),make:()=>bubble(item,side),
    run:faces?{key:side==='you'?youKey(own):side+'|'+(row.from||''),info,make:(first,info)=>bubble(item,side,first,info)}:null});
  }
  for(const item of launch.messages){
   if(item.messageId!==undefined&&rowIds.has(item.messageId))continue;
   const mark=markOfItem(item);
   const sent={text:item.text,mark:copy.mark[mark]||null,markKey:mark,who:copy.who.you,at:item.sentAt,label:toLabel(item)};
   entries.push({t:item.sentAt,id:'l'+item.id,sig:['l',item.id,mark,item.text,sent.label].join('|'),make:()=>bubble(sent,'you'),run:faces?{key:youKey(item),info:null,make:(first)=>bubble(sent,'you',first)}:null});
  }
  entries.sort((a,b)=>a.t-b.t);
  // A streamed reply is the lead's next message, so under faces it joins the lead's run (the lead's key and face) and shows no meta line of its own that the final message would then drop.
  for(const [id,text] of streams){
   if(rowIds.has(id))continue;
   const item={id,text,who:copy.lead,at:clock.now()};
   let run=null;
   if(faces){
    const ref=lastLead||{from:(live()||{}).handle};
    item.who=target.leadName(ref);
    run={key:'lead|'+(ref.from||''),info:faceInfo(ref,'lead',item.who),make:(first,info)=>bubble(item,'lead',first,info)};
   }
   entries.push({t:Infinity,id:'s'+id,sig:'s|'+id+'|'+text,make:()=>bubble(item,'lead'),run});
  }
  // faces: a message that follows one from the same sender joins its run (no meta line); a card, a stream row or another sender starts a new one. The signature carries the position and the face, so a node is rebuilt only when either changes.
  if(faces){
   let before=null;
   for(const entry of entries){
    const run=entry.run,key=run?run.key:null,first=!key||key!==before;
    before=key;
    if(run){entry.sig+='|'+(first?'rs':'rc')+'|'+JSON.stringify(run.info);entry.make=()=>run.make(first,run.info);}
   }
  }
  return entries;
 }
 const awaiting=()=>awaitBase!==null&&leadCount()<=awaitBase&&(launch.state==='joined'||Boolean(live()&&live().state==='running'));
 function render(){
  if(gone)return;
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
  if(replacer)replacer.sync();
  const inChooser=replacer?replacer.within():false;
  const act=activityItem(),want=[...emptyItems(),...threadItems(),{id:'status',node:status},...(awaiting()?[{id:'typing',sig:'t',make:typing}]:[])];
  const held=roving.focused();
  reconcile(log,cache,want);
  for(const id of [...htmlOpen.keys()])if(!cache.has('m'+id))htmlRelease(id);
  roving.refresh(held);
  if(actFoot)reconcile(actFoot,actCache,act?[act]:[]);
  paintChips();
  pin.onContentChanged();
  // The button that sent is gone once the card answers: focus follows to its answered line.
  if(pinState.refocus!==null){const pinButton=log.querySelector(`.pin-b[data-pin-mid="${pinState.refocus}"]`);if(pinButton){pinButton.focus();pinState.refocus=null;}}
  if(replacer)replacer.after(inChooser);
  if(refocusCard!==null){const done=log.querySelector(`[data-card="${refocusCard}"][data-state=answered] .chosen`);if(done){done.focus();refocusCard=null;}}
  if(refocus&&launch.state!=='starting'&&launch.state!=='slow'){refocus=false;const retry=status.querySelector('[data-retry]');if(retry&&(!el.ownerDocument.activeElement||el.ownerDocument.activeElement===el.ownerDocument.body||el.ownerDocument.activeElement===status))retry.focus();}
  composer.update({placeholder:p.placeholder,disabled:isDone,...(layout.composer?layout.composer(here):{})});
  for(const fn of listeners)fn();
 }
 // --- data: the thread is inbox({sessionId}) for each lead row of this story plus the role queue, merged.
 // By source: each answer is kept on its own and a late one never undoes a newer one, so no read is dropped for being old.
 async function readSources(onlyNew){
  const mine=++gen,peers=target.rows(rows);
  for(const row of peers)watched.add(row.sessionId);
  took(await sources.read(mine,onlyNew,early=>{thread=early;render();}));
 }
 // The page's empty copy, only once the thread has read empty: while it reads it says so, and a read that failed says that instead (its alert row).
 function emptyItems(){
  if(!layout.empty||thread.length||launch.messages.length)return [];
  if(fails.has('thread')||fails.has('roster')||(sources&&sources.failedNow()))return [];
  if(!threadRead||(sources&&!sources.settled()))return [{id:'loading',sig:'l',make:()=>h('div',{class:'empty',role:'status','data-row':'loading'},copy.row.loading)}];
  return [{id:'empty',sig:'e',make:()=>h('div',{class:'empty'},layout.empty)}];
 }
 // A thread read landed: it settles the running time, the streamed rows it now holds and the wait for a reply.
 function took(next){
  thread=next;
  threadRead=true;
  if(runningSince===0)runningSince=newestFrom(thread,leadHandles());
  for(const row of thread)streams.delete(row.messageId);
  if(awaitBase!==null&&leadCount()>awaitBase)awaitBase=null;
  render();
 }
 async function readThread(onlyNew=false){
  if(sources)return readSources(onlyNew);
  const mine=++gen,peers=target.rows(rows);
  for(const row of peers)watched.add(row.sessionId);
  let lists;
  try{lists=await target.read(peers,transport);}catch(error){if(mine===gen){fails.set('thread',(error&&error.message)||String(error));render();}return;}
  if(mine!==gen)return;
  fails.delete('thread');
  took(mergeThread(...lists));
 }
 function onRows(next){
  const firstRoster=!gotRows;gotRows=true;
  fails.delete('roster');
  const before=live();rows=next;const now=live();
  if(now&&now.state==='running'&&(!before||before.state!=='running')&&lastLiveState!==null)runningSince=clock.now();
  lastLiveState=now?now.state:'none';
  launch.rows(next);
  const moved=target.follow&&(before&&before.handle)!==(now&&now.handle);
  if(moved)pin.reset();
  // A source (a handle) that comes back on a session not seen before is read again; a roster then reads only the sources it adds.
  const again=sources?sources.seen(target.rows(next),firstRoster):false;
  if(!started||moved||again||target.rows(next).some(row=>!watched.has(row.sessionId))){const more=started&&Boolean(sources);const read=readThread(more);if(!started)firstRead=read;started=true;}else render();
 }
 const detach=send.attach(render);
 const offs=[reads.on('sessions',()=>onRows(reads.latestSessions())),reads.on('inbox',()=>{readThread();}),reads.on('activity',()=>render())];
 if(onPin&&typeof onPin.subscribe==='function')offs.push(onPin.subscribe(()=>render()));
 if(typeof reads.delivery==='function')offs.push(reads.on('delivery',()=>render()));
 if(typeof transport.stream==='function')offs.push(transport.stream(chunk=>{streams.set(chunk.messageId,(streams.get(chunk.messageId)||'')+chunk.text);render();}));
 const releaseSlot=composerSlot?layout.composerSlot(composerSlot):null;
 render();
 if(layout.autofocus!==false)composer.input.focus();
 // A page that reads by source does not wait on the roster: a sessions read that fails or never answers still settles the first thread read.
 if(sources){started=true;firstRead=readThread(true);}
 // A roster that answered before this mount (a page opened with a session in its address reads it first) is taken as the first one.
 function readRoster(){
  const roster=reads.sessions();
  if(sources)roster.then(()=>{if(!gotRows)onRows(reads.latestSessions());},()=>{});
  // Without sources the first thread read waits on the roster: one that fails is the conversation's failure, said with Retry, not a load that never ends.
  else Promise.resolve(roster).catch(error=>{if(!gotRows){fails.set('roster',copy.row.unread+' '+((error&&error.message)||String(error)));render();}});
 }
 readRoster();
 return {
  unmount(){gone=true;for(const id of [...htmlOpen.keys()])htmlRelease(id);offs.forEach(off=>off&&off());if(prose)prose.release();if(typeof releaseSlot==='function')releaseSlot();pin.release();roving.release();if(replacer)replacer.release();mountSlot.release();if(sendOpt)detach();else send.dispose();el.replaceChildren();},
  // The header's lead controls: which are on, and what each does (the page's inline confirm comes first).
  controls:()=>({launch:!isDone&&!live()&&launch.state!=='starting'&&launch.state!=='slow',focus:Boolean(terminalTarget()),stop:Boolean(live()),done:isDone}),
  launchLead:()=>launch.start(),
  focusLead:()=>{const target=terminalTarget();return target?Promise.resolve(transport.gotoAgent(target)):Promise.reject(new Error('not running'));},
  stopLead:()=>{const row=live();return row?Promise.resolve(transport.stop(row.handle)):Promise.reject(new Error('not running'));},
  // The first thread read, once the first roster is in: a page that paints around the chat waits on it. refresh() re-reads the thread.
  loaded:()=>reads.sessions().then(()=>firstRead),refresh:onlyNew=>readThread(onlyNew),
  // A message from another control (a page's starter) goes the way a typed one does; true when it went.
  post:text=>composer.post(text),threadFailed:()=>Boolean(sources&&sources.failedNow()),threadSettled:()=>!sources||sources.settled(),
  presence,launch,showTerminal,thread:()=>thread,leadHandles,terminalOn:()=>Boolean(terminalTarget()),lead:live,
  setDone(value){isDone=Boolean(value);render();},
  repaint:()=>render(),
  subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
 };
}
