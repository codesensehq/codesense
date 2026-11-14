// SPDX-License-Identifier: MIT
// The thread: inbox({sessionId}) for each of this story's lead rows plus inbox({role}), merged by message id and sorted by time.
export const rowsOf=answer=>Array.isArray(answer)?answer:Array.isArray(answer&&answer.messages)?answer.messages:[];
export function mergeThread(...lists){
 const byId=new Map();
 for(const row of lists.flatMap(rowsOf))if(row&&row.messageId!==undefined&&!byId.has(row.messageId))byId.set(row.messageId,row);
 return [...byId.values()].sort((a,b)=>(a.createdAtMs||0)-(b.createdAtMs||0)||(a.messageId>b.messageId?1:-1));
}
// Who a row is from: the person, this story's lead, or someone else.
export const sideOf=(row,leadHandles)=>row.from==='human'?'you':leadHandles.has(row.from)||/^role:/.test(row.from||'')?'lead':'other';
export const newestFrom=(rows,leadHandles)=>rows.filter(row=>sideOf(row,leadHandles)==='lead').reduce((at,row)=>Math.max(at,row.createdAtMs||0),0);
