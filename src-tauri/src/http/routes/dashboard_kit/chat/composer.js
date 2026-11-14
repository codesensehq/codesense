// SPDX-License-Identifier: MIT
// The composer: a pinned region with ids per mount (pages and tests find them by id; mount-ids.js). Enter sends, Shift+Enter is a newline; typing and focus never launch.
import {h} from './dom.js';
import {CHAT_COPY} from './copy.js';
import {idsOf} from './mount-ids.js';
// rows, label, hint and send are the page's own size and words (the page's); update() changes the hint and the send label as the peer comes and goes.
export function createComposer({ids=idsOf(1),onSend,rows='2',label=CHAT_COPY.composerLabel,hint=CHAT_COPY.hint,send:sendLabel=CHAT_COPY.send}){
 const input=h('textarea',{id:ids.input,rows,'aria-label':label,'aria-describedby':ids.hint,spellcheck:'true'});
 const send=h('button',{id:ids.send,type:'button',class:'btn primary'},sendLabel);
 const region=h('div',{id:ids.region,class:'composer'},h('div',{class:'box'},input,send),h('div',{class:'hint',id:ids.hint},hint));
 const submit=()=>{const text=input.value.trim();if(!text||input.disabled)return;input.value='';onSend(text);};
 input.addEventListener('keydown',event=>{if((event.code==='Enter'||event.code==='NumpadEnter')&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}});
 send.addEventListener('click',submit);
 return {region,input,send,
  update({placeholder,disabled,hint:nextHint,send:nextSend}){
   input.placeholder=placeholder;input.disabled=Boolean(disabled);send.disabled=Boolean(disabled);
   if(nextHint!==undefined)region.querySelector('.hint').textContent=nextHint;
   if(nextSend!==undefined)send.textContent=nextSend;
  },
  // setText(text): puts text in the box for the person to edit (a chip's pencil), cursor at the end; false while the composer is disabled.
  setText(text){if(input.disabled)return false;input.value=text;input.focus();input.setSelectionRange(text.length,text.length);return true;},
  // post(text): another control's message (a page's starter) on the same path as a typed one, refused while the composer is disabled. True when it went.
  post(text){if(!text||input.disabled)return false;onSend(text);return true;}};
}
