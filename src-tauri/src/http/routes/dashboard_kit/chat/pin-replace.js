// SPDX-License-Identifier: MIT
// At the cap, Pin… asks which pin to replace (onPin.replace): the chooser under a message, the rule the app's overlay keeps (src/features/inbox/hooks/use-person-pins.ts).
// One row is current: the arrow keys, Home and End move it (handled on the chooser, so the thread's own keys never see them), and with focus inside, the pointer arriving on a row moves it too.
// Enter or a click on the current row replaces that pin in its place, with one Undo for both; a click on another row only arrives on it. A row the agent added since the chooser opened
// must be arrived on first, so nothing the agent just added is replaced unseen. The rows follow the live list and a line says what changed; a pin leaving offers a plain Pin, and the agent
// pinning this message closes the chooser. The page's pins are told which pin the current row would replace (onPin.mark). Esc and Cancel close it, back to Pin….
// The step, arrive-first, list-change and room rules are chat-core's (pinChooser*), the ones the app's overlay runs too; this file draws them and owns focus.
import {h} from './dom.js';
import {timeLabel} from './copy.js';
import {PIN_CAP,PIN_REPLACE_FAILED,PIN_UNDO_FULL,PIN_UNDO_GONE,pinChooserArrive,pinChooserChoose,pinChooserHeading,pinChooserOpen,pinChooserRoom,pinChooserStep,pinChooserSync,pinLiveText,pinPinnedAtLine,pinPinnedMeanwhileText,pinReplacedText,pinWho} from './chat-core.js';
const GLYPH_NS='http://www.w3.org/2000/svg';
// Your own pin is drawn as the pins strip draws it: a quote, or a dashboard's name.
const OWN_PATH={quote:'M3 6h4v4l-2 3M9 6h4v4l-2 3',name:'M2 3h12v10H2zM2 7h12M7 7v6'};
function ownGlyph(kind){const svg=document.createElementNS(GLYPH_NS,'svg'),path=document.createElementNS(GLYPH_NS,'path');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('class','ico');svg.setAttribute('aria-hidden','true');path.setAttribute('d',OWN_PATH[kind]);svg.append(path);return svg;}
/**
 * state is chat.js's pin state ({note, busy, refocus}); live is its polite live region. list() is the thread's pins, nameOf names an agent, titleOf(pin) names a pin as the page's pins do,
 * ownOf(pin) is how a pin with no preview is drawn ('quote'|'name'), idOf(mid) is the chooser's element id, and pinNow(item) pins a message with the room a pin that left made.
 */
export function createPinReplace({onPin,state,live,list,nameOf,titleOf,ownOf,idOf,copy,render,pinNow}){
 let open=null,marked=null,focusWant=false;
 const el=()=>open&&open.node;
 const mark=id=>{if(id===marked)return;marked=id;if(typeof onPin.mark==='function')onPin.mark(id);};
 const close=refocus=>{if(!open)return;if(refocus)state.refocus=open.item.id;open=null;mark(null);};
 function openFor(item){
  const pins=list();
  state.note=null;
  open={...pinChooserOpen(pins),item,node:h('div',{class:'pin-chooser',id:idOf(item.id),role:'group','aria-labelledby':idOf(item.id)+'-h'})};
  open.node.addEventListener('keydown',onKey);
  focusWant=true;
 }
 // The chooser follows the live list: it says what changed, and the row the person was on stops being current if it left. If the agent pinned this message, it closes.
 function sync(){
  if(!open)return;
  const next=pinChooserSync(open,list(),open.item.id,titleOf);
  if(!next)return;
  if(next.pinned){
   const mid=open.item.id;
   close(false);
   state.note={mid,kind:'info',text:pinPinnedMeanwhileText(pinWho(next.pinned.pinnedBy,nameOf))};
   return;
  }
  open=next.state;
  focusWant=true;
 }
 const rowEl=id=>el()&&el().querySelector(`.choice[data-pin-id="${CSS.escape(String(id))}"]`);
 const within=()=>el()&&el().contains(el().ownerDocument.activeElement);
 // The person arrived on a row: it is current, and a row new since the chooser opened can now be replaced.
 function goTo(index){
  const pins=list(),pin=pins[Math.max(0,Math.min(pins.length-1,index))];
  if(!pin||!open)return;
  open=pinChooserArrive(open,pin.messageId);
  focusWant=true;after();
 }
 async function replace(old){
  const item=open.item;
  state.busy=item.id;render();
  try{
   await onPin.change('replace',item.id,{replaces:old.messageId});
   const text=pinReplacedText(pinWho(old.pinnedBy,nameOf),titleOf(old));
   close(false);
   state.note={mid:item.id,kind:'replaced',item,old,text};
   live.textContent=text;
   state.refocus=item.id;
  }catch{
   // Nothing changed: the chooser stays on its row and says so. A list that moved on reaches it through sync.
   if(open){open.error=PIN_REPLACE_FAILED;focusWant=true;}
  }
  state.busy=null;render();
 }
 function choose(id){
  if(!open||state.busy!==null)return;
  const pin=list().find(p=>p.messageId===id);
  if(!pin)return;
  const chosen=pinChooserChoose(open,pin,titleOf);
  // A pin the agent added a moment ago is never replaced unseen: the person arrives first.
  if(!chosen.replace){open=chosen.state;focusWant=true;after();return;}
  replace(pin);
 }
 function onKey(event){
  if(!open)return;
  const pins=list(),fromChange=event.target.classList&&event.target.classList.contains('chg'),at=pins.findIndex(p=>p.messageId===open.current);
  const step=pinChooserStep(event.key,at,pins.length,fromChange);
  if(step!==null&&!open.room){event.preventDefault();event.stopPropagation();goTo(step);return;}
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);render();return;}
  if(event.key==='Enter'&&event.target.classList&&event.target.classList.contains('choice')){event.preventDefault();event.stopPropagation();choose(Number(event.target.getAttribute('data-pin-id')));}
 }
 // The chooser's content, drawn in place: the bubble around it is rebuilt only when it opens or closes, so focus and the Pin survive a move.
 function paint(){
  if(!open)return;
  const pins=list(),room=pinChooserRoom(pins.length),full=room===null,id=idOf(open.item.id),node=open.node;
  open.room=!full;
  node.setAttribute('aria-busy',state.busy===open.item.id?'true':'false');
  const head=h('div',{class:'hd',id:id+'-h'},pinChooserHeading(pins.length));
  const cancel=h('button',{type:'button',class:'btn sm quiet cancel',onclick:()=>{close(true);render();}},copy.cancel);
  if(!full){
   const pin=h('button',{type:'button',class:'btn sm room-pin',onclick:()=>{const item=open.item;close(false);pinNow(item);}},copy.pin);
   node.replaceChildren(head,h('div',{class:'room'},h('span',{},room),pin),cancel);
   mark(null);
   return;
  }
  const rows=pins.map((pin,i)=>{
   const current=pin.messageId===open.current,isNew=!open.known.has(pin.messageId),own=pin.preview?null:ownOf(pin),value=pin.preview&&pin.preview.value;
   const by=pinPinnedAtLine(pinWho(pin.pinnedBy,nameOf),timeLabel(pin.pinnedAtMs));
   return h('button',{type:'button',class:'choice','data-pin-id':String(pin.messageId),'data-current':current?'true':null,'data-new':isNew?'true':null,'data-own':own,tabindex:current||(open.current===null&&i===0)?'0':'-1',
    onpointerenter:()=>{if(within()&&open.current!==pin.messageId)goTo(i);},
    onclick:()=>{
     // A click on a row that isn't current only arrives on it: what replaces is always the row the mark, "Replace" and Enter name. A row new since the chooser opened says so as it arrives.
     if(!open.known.has(pin.messageId))return choose(pin.messageId);
     if(open.current!==pin.messageId)return goTo(i);
     choose(pin.messageId);
    }},
    own?h('span',{class:'dot own'},ownGlyph(own)):h('span',{class:'dot','data-status':pin.preview&&pin.preview.status||'none','aria-hidden':'true'}),
    h('span',{class:'t'},titleOf(pin)),value?h('b',{class:'v'},value):null,isNew?h('span',{class:'new'},copy.isNew):null,
    h('span',{class:'by'},by),current&&!isNew?h('span',{class:'go','aria-hidden':'true'},copy.replace):null);
  });
  const change=open.change?h('div',{class:'chg',tabindex:'-1',role:'status'},open.change):null;
  const error=open.error?h('div',{class:'pin-note danger',role:'alert'},h('span',{},open.error)):null;
  // A chooser with no change line or no error leaves it out: replaceChildren would draw a null as the text "null".
  node.replaceChildren(...[head,change,h('div',{class:'rows'},...rows),error,cancel].filter(Boolean));
  mark(open.current);
 }
 /** After a render (or a move): the chooser is drawn in place, and focus that was in it, or that a move or a change wants there, goes to the current row, else the change
  *  line when the row the person was on left, else the room's Pin. `was` is within() from before the render: a render that rebuilt the message (a busy replace) moved
  *  the chooser and dropped its focus. */
 function after(was=false){
  if(!open||!open.node.isConnected)return;
  const had=was||within();
  paint();
  if(!had&&!focusWant)return;
  focusWant=false;
  const target=open.room?el().querySelector('.room-pin'):open.current!==null?rowEl(open.current):el().querySelector('.chg');
  if(target)target.focus();
 }
 // One Undo for a replace: the new pin goes and the old one comes back, in one step. An Undo the engine refuses (error.refused) goes away and says why, from the list; one that didn't reach it offers Try again.
 async function undo(note){
  if(state.busy!==null)return;
  state.busy=note.mid;render();
  try{
   const pins=await onPin.change('restore',note.old.messageId,{replacing:note.item.id});
   state.note=null;
   live.textContent=pinLiveText('restored',titleOf(note.old),(pins||list()).length);
   state.refocus=note.mid;
  }catch(error){
   if(error&&error.refused){const text=list().length>=PIN_CAP?PIN_UNDO_FULL:PIN_UNDO_GONE;state.note={mid:note.mid,kind:'info',text};live.textContent=text;}
   else state.note={...note,kind:'replace-undo-failed'};
  }
  state.busy=null;render();
 }
 /** The notes this flow owns, under the message: a replace with Undo, its failed Undo, or a line that says why. */
 function foot(note){
  if(note.kind==='replaced')return h('div',{class:'pin-note',role:'note'},h('span',{},note.text),h('button',{type:'button',class:'btn sm',onclick:()=>undo(note)},copy.undo));
  if(note.kind==='replace-undo-failed')return h('div',{class:'pin-note danger',role:'alert'},h('span',{},copy.undoReplaceFailed),h('button',{type:'button',class:'btn sm',onclick:()=>undo({...note,kind:'replaced'})},copy.tryAgain));
  if(note.kind==='info')return h('div',{class:'pin-note',role:'note'},h('span',{},note.text));
  return null;
 }
 return {
  isOpen:mid=>Boolean(open&&open.item.id===mid),
  toggle(item){if(state.busy!==null)return;if(open&&open.item.id===item.id){close(true);render();return;}close(false);openFor(item);render();},
  /** The chooser for this message, or null; drawn fresh into its bubble. */
  node(item){return open&&open.item.id===item.id?open.node:null;},
  // A pin, unpin or replace elsewhere ends the chooser, as it ends an Undo.
  closeFor(mid){if(open&&open.item.id!==mid)close(false);},
  sync,after,foot,
  within:()=>Boolean(within()),
  /** Unmount: the page's pins lose the chooser's mark. */
  release(){close(false);},
 };
}
