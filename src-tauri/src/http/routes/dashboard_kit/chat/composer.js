// SPDX-License-Identifier: MIT
// The composer: a pinned region with ids per mount (pages and tests find them by id; mount-ids.js). It is a two-row box: the textarea, then the hint, its keys and Send on one row under it.
// Enter sends, Shift+Enter is a newline, and ⌘↵ (Ctrl↵) sends with Shift held too; typing and focus never launch.
import {h,imeKey} from './dom.js';
import {CHAT_COPY} from './copy.js';
import {idsOf} from './mount-ids.js';
// rows, label, hint and send are the page's own size and words (the page's); update() changes the hint and the send label as the peer comes and goes, and the input's name (label) while the page gives one.
// onSend(text) may answer a promise (a send to the page's recipient): the box keeps the text, is aria-busy with Send off and takes no other send until it settles, and clears only on true while it still holds that text.
export function createComposer({ids=idsOf(1),onSend,rows='2',label=CHAT_COPY.composerLabel,hint=CHAT_COPY.hint,send:sendLabel=CHAT_COPY.send}){
 const input=h('textarea',{id:ids.input,rows,'aria-label':label,'aria-describedby':ids.hint,spellcheck:'true'});
 const send=h('button',{id:ids.send,type:'button',class:'btn primary'},sendLabel);
 // The send keys as this platform names them: the label is shown, not read (the hint says it in words).
 const mac=typeof navigator!=='undefined'&&/Mac|iPhone|iPad/.test(String(navigator.platform||navigator.userAgent||''));
 const keys=h('span',{class:'keys','aria-hidden':'true'},mac?'⌘↵':'Ctrl↵');
 const region=h('div',{id:ids.region,class:'composer'},h('div',{class:'box'},input,h('div',{class:'box-foot'},h('div',{class:'hint',id:ids.hint},hint),keys,send)));
 let pending=false,disabled=false;
 const setPending=on=>{pending=on;send.disabled=on||disabled;if(on)input.setAttribute('aria-busy','true');else input.removeAttribute('aria-busy');};
 const nameInput=name=>{if(name==null)input.removeAttribute('aria-label');else input.setAttribute('aria-label',name);};
 const submit=()=>{
  const raw=input.value,text=raw.trim();if(!text||input.disabled||pending)return;
  const held=onSend(text);
  if(!held||typeof held.then!=='function'){input.value='';return;}
  setPending(true);held.then(sent=>{setPending(false);if(sent&&input.value===raw)input.value='';},()=>{setPending(false);});
 };
 input.addEventListener('keydown',event=>{if((event.code==='Enter'||event.code==='NumpadEnter')&&(!event.shiftKey||event.metaKey||event.ctrlKey)&&!imeKey(event)){event.preventDefault();submit();}});
 send.addEventListener('click',submit);
 return {region,input,send,
  update({placeholder,disabled:off,hint:nextHint,send:nextSend,label:nextLabel}){
   disabled=Boolean(off);input.placeholder=placeholder;nameInput(nextLabel==null?label:nextLabel);input.disabled=disabled;send.disabled=disabled||pending;
   if(nextHint!==undefined)region.querySelector('.hint').textContent=nextHint;
   if(nextSend!==undefined)send.textContent=nextSend;
  },
  // setText(text): puts text in the box for the person to edit (a chip's pencil), cursor at the end; false while the composer is disabled.
  setText(text){if(input.disabled)return false;input.value=text;input.focus();input.setSelectionRange(text.length,text.length);return true;},
  // post(text): another control's message (a page's starter) on the same path as a typed one, refused while the composer is disabled. True when it went.
  post(text){if(!text||input.disabled)return false;onSend(text);return true;}};
}
