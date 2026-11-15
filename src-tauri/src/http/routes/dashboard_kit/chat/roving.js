// SPDX-License-Identifier: MIT
// rovingThread(log): a chat thread as one Tab stop (the roving tabindex), the rule the app's agent chat overlay keeps (src/features/inbox/hooks/use-roving-thread.ts).
// The active message, by default the newest, and that message's own actions are in the Tab order; every other message and its controls are not. Up and Down move between messages,
// Home and End go to the first and the newest, and focusing anything inside a message makes it the active one (so a Pin's note and Undo stay reachable where the person acted).
// Messages are the log's [data-mid] rows; a log with none stays a Tab stop itself, so it still scrolls by keyboard.
/** What a message can hold that Tab would stop on: its actions, links and framed dashboards. */
const FOCUSABLE='button, a[href], input, select, textarea, iframe, [tabindex]';
/** The tabindex a control had before the thread took it out of the Tab order ("" for none). */
const HELD='data-roving-tabindex';
const ROW='[data-mid]';
/** Put `el` (a message's control) in the Tab order when its message is the stop, else out. */
function setControl(el,on){
 if(on&&el.hasAttribute(HELD)){
  const was=el.getAttribute(HELD);
  el.removeAttribute(HELD);
  if(was==='')el.removeAttribute('tabindex');else el.setAttribute('tabindex',was);
 }else if(!on&&!el.hasAttribute(HELD)){
  el.setAttribute(HELD,el.getAttribute('tabindex')??'');
  el.setAttribute('tabindex','-1');
 }
}
/** Apply the Tab order to `node` and what it holds: rows by `active` (each read as one message), controls by their row. */
function applyTo(node,active){
 const rows=node.matches(ROW)?[node,...node.querySelectorAll(ROW)]:node.querySelectorAll(ROW);
 for(const row of rows){row.tabIndex=row.dataset.mid===active?0:-1;if(!row.hasAttribute('role'))row.setAttribute('role','article');}
 const controls=node.matches(FOCUSABLE)&&!node.matches(ROW)?[node]:[];
 for(const el of [...controls,...node.querySelectorAll(FOCUSABLE)]){
  if(el.matches(ROW))continue;
  const row=el.closest(ROW);
  if(row)setControl(el,row.dataset.mid===active);
 }
}
export function rovingThread(log){
 let picked=null,active=null;
 const keys=()=>[...log.querySelectorAll(ROW)].map(row=>row.dataset.mid);
 // The whole thread on each render; after that only what is added (an image or a frame a message draws after the render).
 function refresh(){
  const all=keys();
  // A message that left the thread hands the stop back to the newest.
  active=picked!==null&&all.includes(picked)?picked:(all.length?all[all.length-1]:null);
  log.tabIndex=all.length?-1:0;
  applyTo(log,active);
 }
 const watch=new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)if(node.nodeType===1)applyTo(node,active);});
 watch.observe(log,{childList:true,subtree:true});
 function moveTo(key){
  if(key===undefined)return;
  picked=key;refresh();
  const row=log.querySelector(`[data-mid="${CSS.escape(key)}"]`);
  if(!row)return;
  row.focus({preventScroll:true});
  if(row.scrollIntoView)row.scrollIntoView({block:'nearest'});
 }
 const onKeyDown=event=>{
  const row=event.target;
  // Only on a message itself: inside it, the keys belong to its controls.
  if(!row.matches||!row.matches(ROW)||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  const all=keys(),at=all.indexOf(row.dataset.mid);
  if(at<0)return;
  const to=event.key==='ArrowUp'?Math.max(0,at-1):event.key==='ArrowDown'?Math.min(all.length-1,at+1):event.key==='Home'?0:event.key==='End'?all.length-1:null;
  if(to===null)return;
  event.preventDefault();
  moveTo(all[to]);
 };
 const onFocusIn=event=>{
  const row=event.target.closest&&event.target.closest(ROW);
  if(row&&log.contains(row)&&row.dataset.mid!==active){picked=row.dataset.mid;refresh();}
 };
 log.addEventListener('keydown',onKeyDown);
 log.addEventListener('focusin',onFocusIn);
 return {
  refresh,
  release(){watch.disconnect();log.removeEventListener('keydown',onKeyDown);log.removeEventListener('focusin',onFocusIn);},
 };
}
