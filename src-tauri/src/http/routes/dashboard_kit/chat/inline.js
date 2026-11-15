// SPDX-License-Identifier: MIT
// A message's text with an inline markdown subset drawn as such: `code`, **strong**, and *em* or _em_. Nodes, never markup: a tag in the text stays text.
// Code is read first and nothing inside it is read. A marker counts only when it opens before a non-space and closes after one, and _em_ only at word edges,
// so snake_case, 2*3*4, a lone ** and an unclosed marker stay as written.
import {h} from './dom.js';
const CODE=/`([^`\n]+)`/g;
const STRONG=/\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const EM=/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g;
// Each rule splits the text it is given into strings and nodes; later rules read only the strings left.
function split(parts,re,make){
 return parts.flatMap(part=>{
  if(typeof part!=='string')return [part];
  const out=[];let at=0;
  for(const match of part.matchAll(re)){
   if(match.index>at)out.push(part.slice(at,match.index));
   out.push(make(match.slice(1).find(group=>group!==undefined)));
   at=match.index+match[0].length;
  }
  if(at<part.length)out.push(part.slice(at));
  return out;
 });
}
export function inlineNodes(text){
 let parts=[String(text??'')];
 parts=split(parts,CODE,inner=>h('code',{},inner));
 parts=split(parts,STRONG,inner=>h('strong',{},inner));
 parts=split(parts,EM,inner=>h('em',{},inner));
 return parts;
}
