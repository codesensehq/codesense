// SPDX-License-Identifier: MIT
// Small DOM helpers: text only, never innerHTML (a title or a commit subject is data, not markup).
export function h(tag,props={},...kids){
 const node=document.createElement(tag);
 for(const[key,value]of Object.entries(props||{})){
  if(value===null||value===undefined||value===false)continue;
  if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key==='style')node.style.cssText=value;
  else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else node.setAttribute(key,value===true?'':String(value));
 }
 node.append(...kids.flat(Infinity).filter(kid=>kid!==null&&kid!==undefined&&kid!==false));return node;
}
// A key that belongs to an input method: still composing, or (WebKit) the Enter that commits a candidate, whose keydown has isComposing false and keyCode 229. It never sends.
export const imeKey=event=>Boolean(event&&(event.isComposing||event.keyCode===229));
