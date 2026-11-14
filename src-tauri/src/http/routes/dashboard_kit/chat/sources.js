// SPDX-License-Identifier: MIT
// A page whose thread is several mailboxes (target.sources) reads each source on its own, so one that fails never hides the rest: the newest answer of each is kept, a source that never answered says so, and one that answered once and then failed is shown as stale.
// ids are what transport.threadOf takes, plus the role queue (ROLE). A read of only the new sources merges with what was read before.
import {mergeThread} from './thread.js';
export const ROLE='\u0000role';
export function createSources({transport,clock,peers,sourcesOf}){
 const bySource=new Map(),readOf=new Map(),asked=new Set(),pending=new Map(),failed=new Set(),failedAt=new Map(),missOf=new Map(),sessionsOf=new Map();
 let mergedKey=null,threadRead=false;
 // pending counts the reads in flight per source: the thread counts as read (threadRead) only once none of its sources is still being read.
 // failed holds the sources whose latest read failed; one never read at all makes failedNow() true, so a page does not take unread history for an empty thread.
 // failedAt: when a source that had answered first failed to refresh; while one of the current sources is in it, the thread says so rather than passing old mail off as current.
 const flight=(id,by)=>{const n=(pending.get(id)||0)+by;if(n>0)pending.set(id,n);else pending.delete(id);};
 const current=()=>[...sourcesOf(peers()),ROLE];
 const merged=()=>mergeThread(...current().map(id=>bySource.get(id)||[]));
 // Settled: the first read is done and no current source that never answered is still being read (one the roster added later counts too); a refresh of answered sources does not unsettle it.
 // waiting: a current source that never answered is still being read.
 const waiting=()=>current().some(id=>pending.has(id)&&!bySource.has(id));
 const settled=()=>threadRead&&!waiting();
 const failedNow=()=>current().some(id=>failed.has(id)&&!bySource.has(id));
 const staleAt=()=>{const times=current().filter(id=>failedAt.has(id)).map(id=>failedAt.get(id));return times.length?Math.min(...times):null;};
 // A handle that comes back on a session not seen before (a relaunch, after a live or an exited row) is read again; its last answer stays until the new one lands, so a failed re-read shows as stale.
 // The first roster only records what it lists: the mount read already asked for every handle in it. Returns whether some source is to be read again.
 function seen(rows,firstRoster){
  let again=false;
  for(const row of rows){
   if(!row.handle)continue;
   const known=sessionsOf.get(row.handle),sessions=known||new Set();
   if(!known)sessionsOf.set(row.handle,sessions);
   if(row.state==='exited'||sessions.has(row.sessionId))continue;
   sessions.add(row.sessionId);
   if(known&&!firstRoster){asked.delete(row.handle);again=true;}
  }
  return again;
 }
 // Reads every source (onlyNew: those not asked for yet). mine is this read's number; onEarly(thread) runs at once when the sources changed since the last merge.
 async function read(mine,onlyNew,onEarly){
  // The role queue is one more source: a read of only the new ones reads it too until it has been asked for.
  const all=current();
  // A source that left the list is forgotten as asked, so it is read again if it comes back.
  for(const id of asked)if(!all.includes(id))asked.delete(id);
  const ids=onlyNew?all.filter(id=>!asked.has(id)):all;
  ids.forEach(id=>{asked.add(id);flight(id,1);});
  // The shown thread follows the current sources at once (a sender back in the window brings its kept answer), not only once the reads land; only when the sources changed.
  const key=current().join('\n');
  if(key!==mergedKey){mergedKey=key;onEarly(merged());}
  // An answer older than one already kept for its source is dropped, and so is a failure older than it; a failed read keeps the source's last answer.
  const newer=id=>(readOf.get(id)||0)<mine;
  // An answer that lands after a newer read of its source failed is kept, but the failure stays shown.
  const keep=(id,list)=>{if(!newer(id))return;readOf.set(id,mine);bySource.set(id,list);if((missOf.get(id)||0)<mine){failed.delete(id);failedAt.delete(id);}else if(!failedAt.has(id))failedAt.set(id,clock.now());};
  const miss=id=>{if(!newer(id))return;missOf.set(id,Math.max(missOf.get(id)||0,mine));failed.add(id);if(!bySource.has(id))asked.delete(id);else if(!failedAt.has(id))failedAt.set(id,clock.now());};
  await Promise.all(ids.map(id=>(id===ROLE?transport.roleThread():transport.threadOf(id)).then(list=>keep(id,list),()=>miss(id)).then(()=>flight(id,-1))));
  mergedKey=current().join('\n');
  if(!waiting())threadRead=true;
  return merged();
 }
 return {read,seen,settled,failedNow,staleAt};
}
