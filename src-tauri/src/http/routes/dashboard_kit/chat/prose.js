// SPDX-License-Identifier: MIT
// The live lead's assistant prose for the working row, from the host's onSessionText when it offers it: the latest chunk, until the turn's final message or the lead's next
// message in the thread. Only the live lead's session is followed; a peer change or unmount lets it go. A refusal (cb(null, error): a remote session, another CLI, no
// sessions:read) or a host without the stream is no prose: the row is what it was without it.
// The line is the chunk's last sentence, so the row shows where the lead is now, not a growing paragraph. It reads as a sentence: a fenced block (with its code) or a table is skipped,
// list, heading and quote markers and backticks are dropped, and a sentence ends only where its punctuation is followed by space (a file name, a version or a URL stays whole).
const FENCE=/^(?:`{3,}|~{3,})/,TABLE=/^\|/;
const plain=line=>line.replace(/^(?:>\s*)+/,'').replace(/^#{1,6}\s+/,'').replace(/^(?:[-*+]|\d+[.)])\s+/,'').replace(/`/g,'').trim();
// The prose lines of a chunk: a fenced block's lines are code, not prose, and a block still being written counts as one.
function proseLines(text){
 let inFence=false;
 return String(text||'').split('\n').map(part=>part.trim()).filter(part=>{
  if(FENCE.test(part)){inFence=!inFence;return false;}
  return part&&!inFence&&!TABLE.test(part);
 });
}
export function lastSentence(text){
 const lines=proseLines(text).map(plain).filter(Boolean);
 const sentences=(lines.pop()||'').split(/(?<=[.!?])\s+/).filter(Boolean);
 return sentences.length?sentences[sentences.length-1]:'';
}
export function createProse({win,clock,render}){
 let sid=null,off=null,now=null;
 function follow(next){
  if(next===sid)return;
  if(typeof off==='function')off();
  off=null;sid=next;now=null;
  const host=win.codesense;
  if(!next||!host||typeof host.onSessionText!=='function')return;
  try{
   off=host.onSessionText(next,(said,error)=>{
    if(sid!==next)return;
    now=!said||error||said.kind==='final'?null:{text:said.text,line:lastSentence(said.text),at:clock.now()};
    render();
   });
  }catch{off=null;}
 }
 return {
  follow,
  /** The prose to show now: none once a lead message newer than it is in the thread. */
  current(newestLeadAt){if(now&&newestLeadAt>now.at)now=null;return now;},
  release(){follow(null);},
 };
}
