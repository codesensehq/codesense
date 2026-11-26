// SPDX-License-Identifier: MIT
// The GIF picker: a popover that searches the active GIF provider and stages one pick, and the staged GIF with its required alt text. It knows no page globals:
// the page passes `act` (the bridge's act), `uiState` (a read of the page's `ui:gif` state) and what to do with a pick.
// Nothing reaches a provider before the person allows that provider: on open the picker reads the provider (`gifProvider`, no network call), asks consent for it
// once (stored as ui:gif {consent:{<provider>:true}}), and passes it on every gifSearch and gifPicked, so a search never goes to a provider nobody agreed to.
import {h,imeKey} from './dom.js';
import {GIF_COPY,GIF_PROVIDER_COPY} from './copy.js';
import {linkChatStyles} from './mount-ids.js';
import {rovingGrid} from './roving.js';

const GIF_ICONS={
 x:[['path',{d:'m6 6 12 12M18 6 6 18'}]],
 search:[['circle',{cx:'11',cy:'11',r:'6.5'}],['path',{d:'m20 20-4.2-4.2'}]],
 imageOff:[['path',{d:'m3 3 18 18M3 9v10a2 2 0 0 0 2 2h14M9 3h10a2 2 0 0 1 2 2v10M5 21l7-7m3-3 1-1 5 5'}]],
 alert:[['circle',{cx:'12',cy:'12',r:'9'}],['path',{d:'M12 8v4m0 4h.01'}]],
 open:[['path',{d:'M15 3h6v6'}],['path',{d:'M10 14 21 3'}],['path',{d:'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'}]],
 key:[['circle',{cx:'7.5',cy:'15.5',r:'4'}],['path',{d:'m10.4 12.6 8.6-8.6M16 7l2.5 2.5M19 4l2 2'}]],
 clock:[['circle',{cx:'12',cy:'12',r:'9'}],['path',{d:'M12 7v5l3 2'}]],
 cloudOff:[['path',{d:'m3 3 18 18M8.5 6.2A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.3 7.3M17 19H7a5 5 0 0 1-2.6-9.3'}]],
 shield:[['path',{d:'M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z'}],['path',{d:'m9 12 2 2 4-4'}]],
};
// An icon from the table above, drawn element by element (fixed shapes, never markup).
function gifIcon(name){
 const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','gp-i');svg.setAttribute('aria-hidden','true');
 for(const [tag,attrs] of GIF_ICONS[name]){const shape=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attrs))shape.setAttribute(key,value);svg.append(shape);}
 return svg;
}
export const GIF_PROVIDERS=['giphy','klipy'];
export const GIF_DEBOUNCE_MS=400;
export const GIF_MIN_QUERY=2;
export const GIF_LIMIT=10;
const GIF_COLS=3;
// Each error code's state: its icon and tone, its action, and whether the field stays inert (typing sends nothing) until that action.
const GIF_STATES={
 noProvider:{icon:'key',action:'settings',inert:true},
 invalidKey:{icon:'key',tone:'bad',action:'settings',inert:true},
 mediaOff:{icon:'imageOff',action:null,inert:true},
 keychainUnavailable:{icon:'alert',tone:'bad',action:'retry',inert:true},
 rateLimited:{icon:'clock',tone:'warn',action:null,inert:true},
 providerUnavailable:{icon:'cloudOff',tone:'bad',action:'retry',inert:false},
 badQuery:{icon:'search',action:null,inert:false},
 failed:{icon:'alert',tone:'bad',action:null,inert:false},
};
// The consent the page's ui:gif state holds: only a literal true allows a provider. A missing or malformed value allows none (fail closed).
export function gifConsentOf(state){
 const consent=state&&typeof state==='object'&&!Array.isArray(state)?state.consent:null;
 if(!consent||typeof consent!=='object'||Array.isArray(consent))return {};
 return Object.fromEntries(GIF_PROVIDERS.filter(p=>consent[p]===true).map(p=>[p,true]));
}
const gifReadState=async uiState=>{try{return gifConsentOf(await (typeof uiState==='function'?uiState():uiState));}catch{return {};}};
let gifIds=0;

// mountGifPicker(el, {act, uiState, onStage, provider, openSettings, onClose, anchor}): the popover, appended to `el` (closed until open()). `provider` is the page's
// guess for the placeholder until gifProvider answers. onStage(pick) takes a pick {provider, id, url, title, alt, previewData, width, height}; onClose(reason)
// hears 'pick', 'escape', 'close', 'outside' or 'notNow'. openSettings() is the Open Settings button's action (no button without it); `anchor` is the
// control that opens the picker, so a click on it is not a click outside.
export function mountGifPicker(el,{act,uiState=null,onStage=()=>{},provider:guess=null,openSettings=null,onClose=()=>{},anchor=null,styles=true}={}){
 const doc=el.ownerDocument||document,win=doc.defaultView||window;
 if(styles)linkChatStyles(doc);
 const n=++gifIds,ids={input:`cs-gif-input-${n}`,grid:`cs-gif-grid-${n}`,now:`cs-gif-now-${n}`,cell:i=>`cs-gif-${n}-${i}`};
 const input=h('input',{id:ids.input,type:'search',class:'gp-input',autocomplete:'off',spellcheck:'false','aria-label':GIF_COPY.searchLabel});
 const clear=h('button',{type:'button',class:'gp-clear','aria-label':GIF_COPY.clear,hidden:true},gifIcon('x'));
 const closeButton=h('button',{type:'button',class:'gp-close','aria-label':GIF_COPY.close},gifIcon('x'));
 const body=h('div',{class:'gp-body'});
 const now=h('span',{id:ids.now,class:'gp-now','aria-live':'polite'});
 const attr=h('span',{class:'gp-attr'});
 const root=h('div',{class:'cs-gif gp',role:'dialog','aria-label':GIF_COPY.dialog,hidden:true},
  h('div',{class:'gp-top'},h('div',{class:'gp-search'},gifIcon('search'),input,clear),closeButton),body,h('div',{class:'gp-foot'},now,attr));
 el.append(root);
 // provider: the one the host named on this open; allowed: the consent read at open; inert: typing sends nothing; seq: the newest search (a stale answer is dropped).
 let open=false,generation=0,provider=GIF_PROVIDERS.includes(guess)?guess:'giphy',allowed={},inert=true,seq=0,timer=null,wake=null,last='',retried=null,grid=null,rover=null,candidates=[];
 const words=()=>GIF_PROVIDER_COPY[provider];
 const later=(fn,ms)=>win.setTimeout(fn,ms);
 const stopTimers=()=>{if(timer!==null){win.clearTimeout(timer);timer=null;}if(wake!==null){win.clearTimeout(wake);wake=null;}};
 function paintProvider(){input.placeholder=words().searchPlaceholder;attr.textContent=words().poweredBy;}
 function setInert(on){inert=on;input.disabled=on;root.classList.toggle('inert',on);}
 function foot(text,{bold=null}={}){now.replaceChildren(...(bold?[h('b',{text:bold}),text]:[text]));}
 function dropGrid(){if(rover){rover.release();rover=null;}grid=null;candidates=[];}
 function chips(){return h('div',{class:'gp-chips'},GIF_COPY.starters.map(text=>h('button',{type:'button',class:'gp-chip',onclick:()=>{if(inert)return;input.value=text;syncClear();searchNow(text);}},text)));}
 function showStart(){dropGrid();body.replaceChildren(h('div',{class:'gp-start'},h('span',{text:GIF_COPY.start(words().name)}),chips()));foot(`${GIF_COPY.typeMore} · ${GIF_COPY.escClose}`);}
 // A state in the body: a title, a line, the fine print, and its buttons.
 function showState({icon,tone='',big,line,fine=null,acts=[],extra=null}){
  dropGrid();
  const node=h('div',{class:`gp-state${tone?' '+tone:''}`,role:'status'},gifIcon(icon),h('div',{class:'gp-big',text:big}),h('p',{text:line}),fine?h('p',{class:'gp-fine',text:fine}):null,acts.length?h('div',{class:'gp-acts'},acts):null,extra);
  body.replaceChildren(node);
  return node;
 }
 function syncClear(){clear.hidden=!input.value||inert;}
 // Each error the verbs return, in its own words. An inert state holds the field until its action: Open Settings, Try again or the end of the wait.
 function showError(result,query){
  const code=GIF_STATES[result&&result.error]?result.error:'failed';
  const kind=GIF_STATES[code],text=GIF_COPY.state[code],name=words().name;
  const seconds=Number(result&&result.retryAfter);
  const wait=GIF_COPY.wait(Number.isFinite(seconds)&&seconds>0?seconds:60);
  const acts=[];
  if(kind.action==='settings'&&openSettings)acts.push(h('button',{type:'button',class:'gp-btn primary',onclick:()=>{openSettings();}},gifIcon('open'),GIF_COPY.openSettings));
  // Try again once: a second failure of the same kind keeps the message with no button.
  if(kind.action==='retry'&&retried!==code)acts.push(h('button',{type:'button',class:'gp-btn outline',onclick:()=>{retried=code;setInert(false);searchNow(query);}},GIF_COPY.tryAgain));
  const why=result&&typeof result.message==='string'?result.message:String(result&&result.error||'');
  showState({icon:kind.icon,tone:kind.tone,big:typeof text.big==='function'?text.big(name):text.big,line:text.body(name,wait,why),fine:kind.action==='settings'?GIF_COPY.settingsPath:null,acts});
  foot('');
  setInert(kind.inert);syncClear();
  if(code==='rateLimited'){
   // The bucket is shared with agents: no retry, and the field wakes when the wait ends.
   wake=later(()=>{wake=null;if(!open)return;setInert(false);syncClear();showStart();input.focus();},(Number.isFinite(seconds)&&seconds>0?seconds:60)*1000);
  }
  if(acts.length)acts[0].focus();else if(!inert)input.focus();
 }
 function showConsent(){
  setInert(true);syncClear();
  const name=words().name;
  const allow=h('button',{type:'button',class:'gp-btn primary',onclick:()=>void allowSearch()},GIF_COPY.consent.allow);
  const notNow=h('button',{type:'button',class:'gp-btn outline',onclick:()=>close('notNow')},GIF_COPY.consent.notNow);
  showState({icon:'shield',big:GIF_COPY.consent.big(name),line:GIF_COPY.consent.body(name),fine:GIF_COPY.consent.fine,acts:[allow,notNow]});
  foot('');
  allow.focus();
 }
 // Allow: the current map, with this provider's true, written back whole, so the other provider's answer is kept. A failed write still allows this open; the next open asks again.
 async function allowSearch(){
  const at=generation,asked=provider;
  const current=await gifReadState(uiState);
  allowed={...current,[asked]:true};
  try{await act('setUiState',{topic:'ui:gif',patch:{consent:allowed}});}catch{}
  if(at!==generation||!open)return;
  ready();
 }
 function ready(){setInert(false);input.value='';last='';retried=null;syncClear();showStart();input.focus();}
 // The provider the host names, then its consent. An error here (Off, no key, the team's media off) is the state.
 async function readProvider(){
  const at=generation;
  let answer;
  try{answer=await act('gifProvider',{});}catch(e){answer={status:'error',error:'failed',message:e&&e.message||String(e)};}
  if(at!==generation||!open)return null;
  // With no provider named, nothing can be searched: the field stays inert whatever the error.
  if(!answer||answer.status!=='ok'||!GIF_PROVIDERS.includes(answer.provider)){showError(answer,'');setInert(true);syncClear();return null;}
  provider=answer.provider;paintProvider();
  return provider;
 }
 async function start(){
  const at=generation;
  setInert(true);dropGrid();
  body.replaceChildren(h('div',{class:'gp-start',role:'status',text:GIF_COPY.loading}));foot('');
  const [named,consent]=await Promise.all([readProvider(),gifReadState(uiState)]);
  if(at!==generation||!open||!named)return;
  allowed=consent;
  if(allowed[named])ready();else showConsent();
 }
 function showSkeleton(){
  dropGrid();
  body.replaceChildren(h('div',{class:'gp-grid','aria-hidden':'true'},Array.from({length:GIF_LIMIT},()=>h('span',{class:'gp-cell skel'}))));
  foot(GIF_COPY.searching(words().name));
 }
 function showResults(list){
  dropGrid();
  candidates=list;
  grid=h('div',{id:ids.grid,class:'gp-grid',role:'listbox',tabindex:'0','aria-label':GIF_COPY.results});
  list.forEach((c,i)=>{
   const title=c.title||GIF_COPY.untitled;
   const cell=h('div',{id:ids.cell(i),class:'gp-cell',role:'option','aria-selected':'false','aria-label':c.previewData?title:`${title} (${GIF_COPY.failedStill})`,'data-index':String(i)});
   // A still that is missing or fails to draw is an empty tile, never an error.
   const empty=()=>{cell.classList.add('failed');cell.replaceChildren(gifIcon('imageOff'));};
   if(typeof c.previewData==='string'&&c.previewData.startsWith('data:image/')){
    const img=h('img',{alt:'',src:c.previewData,draggable:'false'});
    img.addEventListener('error',empty);
    cell.append(img);
   }else empty();
   cell.addEventListener('mouseenter',()=>foot(` · ${GIF_COPY.hover}`,{bold:title}));
   cell.addEventListener('click',()=>pick(i));
   grid.append(cell);
  });
  rover=rovingGrid(grid,{cols:GIF_COLS,onMove:cell=>{const c=candidates[Number(cell.dataset.index)];foot(` · ${GIF_COPY.focus}`,{bold:c&&c.title||GIF_COPY.untitled});},onPick:cell=>pick(Number(cell.dataset.index))});
  grid.addEventListener('focus',()=>grid.classList.add('kbd'));
  grid.addEventListener('blur',()=>grid.classList.remove('kbd'));
  body.replaceChildren(grid);
  foot(`${GIF_COPY.typeMore} · ${GIF_COPY.escClose}`);
 }
 // One search for `query` with this open's provider. A mismatch (Settings switched the provider while the popover was open) comes back as badQuery before any
 // key read: the picker reads the provider again and, if it changed, asks consent for the new one.
 async function searchNow(query){
  if(timer!==null){win.clearTimeout(timer);timer=null;}
  const q=query.trim();
  if(inert||!open||!allowed[provider])return;
  if(q.length<GIF_MIN_QUERY){seq++;showStart();return;}
  const mine=++seq,at=generation,asked=provider;
  last=q;
  showSkeleton();
  let result;
  try{result=await act('gifSearch',{query:q,limit:GIF_LIMIT,provider:asked});}catch(e){result={status:'error',error:'failed',message:e&&e.message||String(e)};}
  if(mine!==seq||at!==generation||!open)return;
  if(result&&result.status==='ok'&&Array.isArray(result.candidates)){
   retried=null;
   if(!result.candidates.length){showState({icon:'search',big:GIF_COPY.noResults.big(q),line:GIF_COPY.noResults.body,extra:chips()});foot('');return;}
   showResults(result.candidates.slice(0,GIF_LIMIT));return;
  }
  if(result&&result.error==='badQuery'){
   const named=await readProvider();
   if(mine!==seq||at!==generation||!open||!named)return;
   if(named!==asked){allowed=await gifReadState(uiState);if(at!==generation||!open)return;if(!allowed[named]){showConsent();return;}searchNow(q);return;}
  }
  showError(result,q);
 }
 function pick(index){
  const c=candidates[index];
  if(!c)return;
  const chosen={provider,id:String(c.id),url:c.url,title:c.title||'',alt:c.title||'',previewData:typeof c.previewData==='string'?c.previewData:null,width:c.width,height:c.height};
  // The provider's terms ask for a registration per pick; it goes out in the background and never blocks the stage.
  Promise.resolve().then(()=>act('gifPicked',{provider:chosen.provider,id:chosen.id})).catch(()=>{});
  close('pick');
  onStage(chosen);
 }
 input.addEventListener('input',()=>{
  syncClear();
  if(inert)return;
  if(timer!==null)win.clearTimeout(timer);
  const q=input.value.trim();
  // Under two characters nothing goes out, and an answer still on its way is dropped.
  if(q.length<GIF_MIN_QUERY){timer=null;seq++;showStart();return;}
  timer=later(()=>{timer=null;if(input.value.trim()!==last||!grid)searchNow(input.value);},GIF_DEBOUNCE_MS);
 });
 input.addEventListener('keydown',event=>{
  if(imeKey(event))return;
  if(event.key==='Enter'){event.preventDefault();if(!inert)searchNow(input.value);}
  else if(event.key==='ArrowDown'&&grid){event.preventDefault();grid.focus();}
 });
 clear.addEventListener('click',()=>{input.value='';syncClear();seq++;last='';if(!inert)showStart();input.focus();});
 closeButton.addEventListener('click',()=>close('close'));
 root.addEventListener('keydown',event=>{if(event.key==='Escape'&&!imeKey(event)){event.preventDefault();event.stopPropagation();close('escape');}});
 const outside=event=>{if(!open)return;const t=event.target;if(root.contains(t)||(anchor&&anchor.contains(t)))return;close('outside');};
 function openPicker(){
  if(open)return;
  open=true;generation++;
  root.hidden=false;
  if(anchor)anchor.setAttribute('aria-expanded','true');
  input.value='';last='';retried=null;syncClear();paintProvider();
  doc.addEventListener('pointerdown',outside,true);
  input.focus();
  void start();
 }
 function close(reason='close'){
  if(!open)return;
  open=false;generation++;seq++;stopTimers();dropGrid();
  root.hidden=true;
  if(anchor)anchor.setAttribute('aria-expanded','false');
  doc.removeEventListener('pointerdown',outside,true);
  onClose(reason);
 }
 return {
  root,
  open:openPicker,
  close:()=>close('close'),
  toggle(){if(open)close('close');else openPicker();},
  isOpen:()=>open,
  destroy(){close('close');root.remove();},
 };
}

// mountGifStage(el, {pick, onRemove, onChange, onEnter}): the staged GIF inside the composer box, above the text. Its alt text is required: prefilled with the
// provider's cleaned title; empty, the field is red with the reason and valid() is false. × or Backspace on the thumbnail removes it (onRemove); Enter in the alt
// field calls onEnter (the page moves to the message) and never sends; onChange(valid) hears each edit. The thumbnail is the still: the animated rendition
// is a provider URL the page's CSP does not load, so it plays only once sent, in the thread.
export function mountGifStage(el,{pick,onRemove=()=>{},onChange=()=>{},onEnter=()=>{},styles=true}){
 const doc=el.ownerDocument||document;
 if(styles)linkChatStyles(doc);
 const n=++gifIds,altId=`cs-gif-alt-${n}`,helpId=`cs-gif-alt-help-${n}`;
 const words=GIF_PROVIDER_COPY[pick.provider]||GIF_PROVIDER_COPY.giphy;
 const alt=h('input',{id:altId,class:'gs-in',type:'text',autocomplete:'off',placeholder:GIF_COPY.stage.placeholder,'aria-describedby':helpId,'aria-required':'true'});
 alt.value=pick.alt||'';
 const help=h('div',{id:helpId,class:'gs-help'});
 const removeButton=h('button',{type:'button',class:'gs-x','aria-label':GIF_COPY.stage.remove},gifIcon('x'));
 const thumb=h('div',{class:'gs-thumb',tabindex:'0',role:'img'},pick.previewData?h('img',{alt:'',src:pick.previewData,draggable:'false'}):gifIcon('imageOff'),removeButton);
 const root=h('div',{class:'cs-gif gs'},
  h('div',{class:'gs-media'},thumb,h('span',{class:'gs-attr',text:words.poweredBy})),
  h('div',{class:'gs-f'},h('label',{for:altId},GIF_COPY.stage.alt,' ',h('span',{class:'gs-req',text:GIF_COPY.stage.required})),alt,help));
 let gone=false;
 const valid=()=>Boolean(alt.value.trim());
 function paint(){
  const ok=valid();
  thumb.setAttribute('aria-label',GIF_COPY.stage.thumb(alt.value.trim()));
  alt.classList.toggle('err',!ok);
  if(ok)alt.removeAttribute('aria-invalid');else alt.setAttribute('aria-invalid','true');
  help.classList.toggle('err',!ok);
  help.replaceChildren(...(ok?[h('span',{text:GIF_COPY.stage.help(words.name)})]:[gifIcon('alert'),h('span',{text:GIF_COPY.stage.missing})]));
 }
 function remove(){if(gone)return;gone=true;root.remove();onRemove();}
 alt.addEventListener('input',()=>{paint();onChange(valid());});
 alt.addEventListener('keydown',event=>{if(event.key==='Enter'&&!imeKey(event)){event.preventDefault();onEnter();}});
 thumb.addEventListener('keydown',event=>{if((event.key==='Backspace'||event.key==='Delete')&&event.target===thumb){event.preventDefault();remove();}});
 removeButton.addEventListener('click',remove);
 paint();
 el.prepend(root);
 return {
  root,
  alt:()=>alt.value.trim(),
  valid,
  // The alt field with its text selected, so typing replaces the title.
  focusAlt(){alt.focus();alt.select();},
  // The send's media: the animated rendition, its alt text and where it came from.
  media:()=>({url:pick.url,alt:alt.value.trim(),provider:pick.provider,providerId:pick.id}),
  remove,
  // Gone without onRemove: the page cleared it after a send.
  clear(){if(gone)return;gone=true;root.remove();},
 };
}
