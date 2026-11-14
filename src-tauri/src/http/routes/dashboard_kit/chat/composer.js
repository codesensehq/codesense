// SPDX-License-Identifier: MIT
// The composer: a pinned region with stable ids (pages and tests find them by id). Enter sends, Shift+Enter is a newline; typing and focus never launch.
import {h} from './dom.js';
import {CHAT_COPY} from './copy.js';
export const COMPOSER_IDS={region:'sv-composer',input:'sv-composer-input',send:'sv-send',hint:'sv-composer-hint'};
// rows, label, hint and send are the page's own size and words (the page's); update() changes the hint and the send label as the peer comes and goes.
export function createComposer({onSend,rows='2',label=CHAT_COPY.composerLabel,hint=CHAT_COPY.hint,send:sendLabel=CHAT_COPY.send}){
 const input=h('textarea',{id:COMPOSER_IDS.input,rows,'aria-label':label,'aria-describedby':COMPOSER_IDS.hint,spellcheck:'true'});
 const send=h('button',{id:COMPOSER_IDS.send,type:'button',class:'btn primary'},sendLabel);
 const region=h('div',{id:COMPOSER_IDS.region,class:'composer'},h('div',{class:'box'},input,send),h('div',{class:'hint',id:COMPOSER_IDS.hint},hint));
 const submit=()=>{const text=input.value.trim();if(!text||input.disabled)return;input.value='';onSend(text);};
 input.addEventListener('keydown',event=>{if((event.code==='Enter'||event.code==='NumpadEnter')&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}});
 send.addEventListener('click',submit);
 return {region,input,send,
  update({placeholder,disabled,hint:nextHint,send:nextSend}){
   input.placeholder=placeholder;input.disabled=Boolean(disabled);send.disabled=Boolean(disabled);
   if(nextHint!==undefined)region.querySelector('.hint').textContent=nextHint;
   if(nextSend!==undefined)send.textContent=nextSend;
  },
  // post(text): another control's message (a page's starter) on the same path as a typed one, refused while the composer is disabled. True when it went.
  post(text){if(!text||input.disabled)return false;onSend(text);return true;}};
}
