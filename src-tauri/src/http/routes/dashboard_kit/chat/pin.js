// SPDX-License-Identifier: MIT
// pinToBottom(log, {settle, win}): the one "stay at the newest message" rule for every chat log (any page's chat log; other chat views can reuse it).
// A reader within PIN_NEAR px of the bottom is following: the log goes to the newest message on open, whenever the caller reports new content (onContentChanged) and, with settle, whenever the log's box resizes
// or fonts finish loading, so a layout that was not final at first paint cannot strand the log above the newest message. A reader who scrolls up stops following and keeps their place.
// No timers: ResizeObserver, document.fonts.ready and one animation frame.
const PIN_NEAR=80;
export function pinToBottom(log,{settle=true,win=window}={}){
 let following=true,released=false;
 const near=()=>log.scrollHeight-log.scrollTop-log.clientHeight<PIN_NEAR;
 const follow=()=>{if(following&&!released)log.scrollTop=log.scrollHeight;};
 const onScroll=()=>{following=near();};
 log.addEventListener('scroll',onScroll);
 let observer=null;
 if(settle){
  if(typeof win.ResizeObserver==='function'){observer=new win.ResizeObserver(follow);observer.observe(log);}
  const fonts=win.document&&win.document.fonts;
  if(fonts&&fonts.ready)fonts.ready.then(follow);
  win.requestAnimationFrame(follow);
 }
 follow();
 return {
  onContentChanged:follow,
  // Another thread is opening (the peer changed): the reader follows it from its newest message, whatever they did in the last one.
  reset(){following=true;follow();},
  release(){released=true;log.removeEventListener('scroll',onScroll);if(observer)observer.disconnect();},
 };
}
