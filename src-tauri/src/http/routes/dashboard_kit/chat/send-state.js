// SPDX-License-Identifier: MIT
// A chat's send state: what the user has sent or asked to send, and the launch that carries it. It outlives the chat's DOM, so a page that hides and shows its chat again does not lose a message or its mark.
// It holds the launch controller (each message and its mark, the outbox, the prompt's items, the launch's timers, a send waiting on the host), the answers to cards sent from this page, and the unload guard for held or kept messages.
// A mounted chat attaches its render; hidden, the state paints nothing. While detached and unsettled it listens to the roster the host already holds (reads.on('sessions'): no bridge subscription, no read), so a lead that joins while the page is
// hidden gets the held messages then. It ends only with the page (dispose), never on hide.
import {createLaunch} from './launch.js';
import {CHAT_COPY,mergeCopy} from './copy.js';
export const systemClock=()=>({now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)});
export const DEFAULT_TIMERS={slowMs:20000,failMs:120000};
export function createSendState({transport,reads,clock=systemClock(),timers=DEFAULT_TIMERS,card=text=>text,target,storyId=null,leadRole=null,win=window,copy:words=null}){
 const copy=words?mergeCopy(words):CHAT_COPY;
 let attached=null,feed=null,ended=false;
 const stopFeed=()=>{if(feed){feed();feed=null;}};
 // Detached, the launch changes without a chat to paint: the roster feeds it only while it has work, and stops when the work settles.
 const sync=()=>{
  if(attached||ended)return;
  if(launch.unsettled()){if(!feed)feed=reads.on('sessions',()=>launch.rows(reads.latestSessions()));}
  else stopFeed();
 };
 const launch=createLaunch({transport,clock,storyId,leadRole,timers,card,onChange:sync,rowsOf:target.rows,queue:target.queue,pickLive:target.pick,bindLaunched:target.bindLaunched,keepUnsent:target.keepUnsent});
 // Cards answered from this page: id -> {phase:'pending'|'error'|'answered', text, at, failure} (the chat's answerCard).
 const cards=new Map();
 const onUnload=event=>{if(launch.hasHeld()){const text=launch.hasKept()?copy.unloadKept:copy.unload;event.preventDefault();event.returnValue=text;return text;}};
 win.addEventListener('beforeunload',onUnload);
 return {
  launch,cards,
  unsettled:()=>launch.unsettled(),
  // The mounted chat's render takes the launch's changes; the returned detach hands them back to the state, which keeps listening only while it has work.
  attach(render){
   stopFeed();attached=render;launch.attach(render);
   return ()=>{if(attached!==render)return;attached=null;launch.attach(sync);sync();};
  },
  dispose(){ended=true;attached=null;stopFeed();launch.attach(null);launch.dispose();win.removeEventListener('beforeunload',onUnload);},
 };
}
