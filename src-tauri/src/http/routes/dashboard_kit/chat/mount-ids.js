// SPDX-License-Identifier: MIT
// Per-mount ids and the stylesheet link. Two chats on one page must not share an id: a mount takes the lowest slot whose composer is not already in the page outside its own element. Slot 1 keeps the plain ids pages and tests already use; the next ones carry -2, -3.
export function idsOf(n){
 const tail=n>1?`-${n}`:'';
 return {region:`sv-composer${tail}`,input:`sv-composer-input${tail}`,send:`sv-send${tail}`,hint:`sv-composer-hint${tail}`,status:`sv-status${tail}`,term:kind=>`sv-term-${kind}${tail}`};
}
export function mountIds(doc,el){
 for(let n=1;;n++){
  const ids=idsOf(n),used=doc.getElementById(ids.region);
  if(!used||el.contains(used))return ids;
 }
}
// The chat's stylesheet, linked once per page (served at /kit/v1/chat.css); a page that brings its own rules mounts with styles:false.
export const CHAT_CSS_HREF='/kit/v1/chat.css';
export function linkChatStyles(doc){
 if(!doc.head||doc.head.querySelector('link[data-codesense-chat]'))return;
 const link=doc.createElement('link');
 link.rel='stylesheet';link.href=CHAT_CSS_HREF;link.setAttribute('data-codesense-chat','');
 doc.head.append(link);
}
