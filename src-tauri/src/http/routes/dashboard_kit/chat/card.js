// SPDX-License-Identifier: MIT
// One needs-you card in the thread (the question, its options, and the answered state). The node is built from plain values by chat.js, which owns the state; a card changes only when its signature does.
// state: open | pending (a reply waits on the host confirm) | error | answered. A parsed card shows the lead's pick first; one chat-core cannot parse shows its text and a reply box.
import {h} from './dom.js';
import {CHAT_COPY,timeLabel} from './copy.js';
const CARD_COPY=CHAT_COPY.card;
export function cardNode({id,text,parsed,at,state,answer,failure,draft,onAnswer,onDraft,lead=CHAT_COPY.lead}){
 const answered=state==='answered',busy=state==='pending',inInbox=answered&&answer.where==='inbox';
 const head=h('div',{class:'card-h'},h('b',{},answered?(inInbox?CARD_COPY.answeredInbox:CARD_COPY.answered):CARD_COPY.needs),h('span',{},CARD_COPY.from(lead,timeLabel(at))),h('span',{class:'sp'}),answered?null:h('span',{},CARD_COPY.alsoInbox));
 const body=h('div',{class:'body'},parsed?parsed.question:text);
 const parts=[head,body];
 if(parsed&&!(answered&&!inInbox)){
  parts.push(h('div',{class:'opts',role:'group','aria-label':CARD_COPY.options},...parsed.options.map(option=>
   h('button',{type:'button',class:option===parsed.pick&&!answered?'btn primary':'btn','data-ans':option,disabled:answered||busy?'':null,onclick:()=>onAnswer(option)},option,option===parsed.pick&&!answered?h('span',{class:'rec'},` · ${CARD_COPY.recommended}`):null))));
 }else if(!parsed&&!answered){
  const input=h('textarea',{rows:'2','aria-label':CARD_COPY.replyLabel,spellcheck:'true',disabled:busy?'':null});
  input.value=draft||'';
  const send=()=>{const value=input.value.trim();if(value&&!busy)onAnswer(value);};
  input.addEventListener('input',()=>onDraft(input.value));
  input.addEventListener('keydown',event=>{if((event.code==='Enter'||event.code==='NumpadEnter')&&!event.shiftKey&&!event.isComposing){event.preventDefault();send();}});
  parts.push(h('div',{class:'reply'},input,h('button',{type:'button',class:'btn','data-reply':'1',disabled:busy?'':null,onclick:send},CARD_COPY.reply)));
 }
 if(answered)parts.push(h('div',{class:'chosen',tabindex:'-1',role:'status'},CARD_COPY.chose,' ',h('b',{},answer.text),` · ${inInbox?CARD_COPY.inbox:CARD_COPY.here} · ${timeLabel(answer.at)}`));
 if(state==='error'&&failure)parts.push(h('div',{class:'sys danger',role:'alert'},h('span',{class:'why'},CARD_COPY.failed(failure))));
 return h('div',{class:'msg lead','data-mid':String(id)},h('div',{class:'card','data-card':String(id),'data-state':state},...parts));
}
