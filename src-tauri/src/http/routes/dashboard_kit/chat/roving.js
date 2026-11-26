// SPDX-License-Identifier: MIT
// rovingThread(log): a chat thread as one Tab stop (the roving tabindex). The kit's chat and the app's agent chat overlay (src/features/inbox/hooks/use-roving-thread.ts wraps this module) share it.
// The active message, by default the newest, and that message's own actions are in the Tab order; every other message and its controls are not. Up and Down move between messages,
// Home and End go to the first and the newest, and focusing anything inside a message makes it the active one (so a Pin's note and Undo stay reachable where the person acted).
// Messages are the log's [data-mid] rows; a log with none stays a Tab stop itself, so it still scrolls by keyboard.
/** What a message can hold that Tab would stop on: its actions, links and framed dashboards, and the code blocks and tables Chromium makes keyboard-focusable when
 *  they scroll (with no tabindex). */
const FOCUSABLE='button, a[href], input, select, textarea, iframe, [tabindex], pre, .inbox-table-scroll';
/** The blocks that scroll inside a message, and the name each one gets when it does (it is a Tab stop then, and a stop needs a name). */
const SCROLLER='pre, .inbox-table-scroll';
const SCROLLER_NAME={code:'Code',table:'Table'};
/** The active message's unnamed blocks that scroll, in `node` (the active row itself, inside it, or holding it). Only the stop's blocks are Tab stops, so only they are
 *  measured, and all of them before anything is written. Returns the writes: each names its block as a region (one that fits is left alone; a named region on every block
 *  would only be noise). */
function scrollerNames(node,active){
 if(active===null)return ()=>{};
 const own=node.closest?node.closest(ROW):null;
 const row=own?(own.dataset.mid===active?own:null):node.querySelector(`[data-mid="${CSS.escape(active)}"]`);
 if(!row)return ()=>{};
 const blocks=[...row.querySelectorAll(SCROLLER)].filter(el=>!el.hasAttribute('aria-label')&&!el.hasAttribute('aria-labelledby'));
 const scrolls=blocks.filter(el=>el.scrollWidth>el.clientWidth||el.scrollHeight>el.clientHeight);
 return ()=>{for(const el of scrolls){if(!el.hasAttribute('role'))el.setAttribute('role','region');el.setAttribute('aria-label',el.matches('pre')?SCROLLER_NAME.code:SCROLLER_NAME.table);}};
}
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
 const name=scrollerNames(node,active);
 const rows=node.matches(ROW)?[node,...node.querySelectorAll(ROW)]:node.querySelectorAll(ROW);
 for(const row of rows){row.tabIndex=row.dataset.mid===active?0:-1;if(!row.hasAttribute('role'))row.setAttribute('role','article');}
 const controls=node.matches(FOCUSABLE)&&!node.matches(ROW)?[node]:[];
 for(const el of [...controls,...node.querySelectorAll(FOCUSABLE)]){
  if(el.matches(ROW))continue;
  const row=el.closest(ROW);
  if(row)setControl(el,row.dataset.mid===active);
 }
 name();
}
export function rovingThread(log){
 let picked=null,active=null;
 const keys=()=>[...log.querySelectorAll(ROW)].map(row=>row.dataset.mid);
 /** The message focus is in, before a render that may rebuild its node. */
 const focused=()=>{const at=log.ownerDocument.activeElement,row=at&&log.contains(at)&&at.closest(ROW);return row?row.dataset.mid:null;};
 // The whole thread once when the stop moves; after that only what is added (a rebuilt message, or an image or a frame a message draws after the render).
 // `held` is focused() from before the render: a message whose node the render rebuilt (a mark, a pin, a stream turning final) keeps focus on its new node, and
 // one that left hands it to the newest, so focus never drops to the page.
 function refresh(held=null){
  const all=keys();
  // A message that left the thread hands the stop back to the newest.
  const next=picked!==null&&all.includes(picked)?picked:(all.length?all[all.length-1]:null);
  log.tabIndex=all.length?-1:0;
  if(next!==active){active=next;applyTo(log,active);}
  if(held===null||active===null||log.contains(log.ownerDocument.activeElement))return;
  const row=log.querySelector(`[data-mid="${CSS.escape(active)}"]`);
  if(!row)return;
  applyTo(row,active);
  row.focus({preventScroll:true});
 }
 const watch=new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)if(node.nodeType===1)applyTo(node,active);});
 watch.observe(log,{childList:true,subtree:true});
 function moveTo(key){
  if(key===undefined)return;
  picked=key;refresh();
  const row=log.querySelector(`[data-mid="${CSS.escape(key)}"]`);
  if(!row)return;
  // The new stop takes the tabindex before it takes focus, so focus never sits on a -1 row.
  row.tabIndex=0;
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
  if(!row||!log.contains(row))return;
  if(row.dataset.mid!==active){picked=row.dataset.mid;refresh();}
  // A thread drawn while hidden measured nothing as scrolling: the stop's blocks are named again as focus comes in.
  else scrollerNames(row,active)();
 };
 log.addEventListener('keydown',onKeyDown);
 log.addEventListener('focusin',onFocusIn);
 return {
  focused,
  refresh,
  // Where focus goes when the thread is entered from outside it (Jump to latest): the newest message.
  focusNewest(){moveTo(keys().at(-1));},
  release(){watch.disconnect();log.removeEventListener('keydown',onKeyDown);log.removeEventListener('focusin',onFocusIn);},
 };
}
// rovingGrid(list, {cols, onMove, onPick}): a grid of [role=option] cells as one Tab stop. The list keeps focus and names the active cell with aria-activedescendant;
// the arrows move it (Up and Down by a row of `cols`), Home and End go to the first and the last, and Enter or Space picks it. onMove(cell) hears each move.
export function rovingGrid(list,{cols=1,onMove=()=>{},onPick=()=>{}}={}){
 let at=-1;
 const cells=()=>[...list.querySelectorAll('[role=option]')];
 function moveTo(index){
  const all=cells();
  if(!all.length){at=-1;list.removeAttribute('aria-activedescendant');return;}
  at=Math.max(0,Math.min(all.length-1,index));
  all.forEach((cell,i)=>cell.setAttribute('aria-selected',String(i===at)));
  list.setAttribute('aria-activedescendant',all[at].id);
  if(all[at].scrollIntoView)all[at].scrollIntoView({block:'nearest'});
  onMove(all[at]);
 }
 const onKeyDown=event=>{
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  const last=cells().length-1;
  if(last<0)return;
  if(event.key==='Enter'||event.key===' '){event.preventDefault();if(at>=0)onPick(cells()[at]);return;}
  const to=event.key==='ArrowRight'?at+1:event.key==='ArrowLeft'?at-1:event.key==='ArrowDown'?at+cols:event.key==='ArrowUp'?at-cols:event.key==='Home'?0:event.key==='End'?last:null;
  if(to===null)return;
  event.preventDefault();
  // A move off the grid's edge stays on the cell it is on.
  if(to<0||to>last)return;
  moveTo(to);
 };
 const onFocus=()=>moveTo(at<0?0:at);
 list.addEventListener('keydown',onKeyDown);
 list.addEventListener('focus',onFocus);
 return {
  active:()=>cells()[at]||null,
  moveTo,
  // A new set of cells: nothing is active until the list takes focus again.
  reset(){at=-1;list.removeAttribute('aria-activedescendant');},
  release(){list.removeEventListener('keydown',onKeyDown);list.removeEventListener('focus',onFocus);},
 };
}
