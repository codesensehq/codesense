// SPDX-License-Identifier: MIT
// Presence: one state from the lead's sessions() row, shared by the face, the header line and the composer placeholder.
import {CHAT_COPY,failureReason} from './copy.js';
// Every row of this story's lead (a relaunch lists more than one) and the one that is live (any state but exited).
export const leadRowsOf=(rows,storyId,role)=>(Array.isArray(rows)?rows:[]).filter(row=>row.story===storyId&&row.role===role);
// The one live rule: the first row that has not exited (any other state counts as live to presence).
export const liveOf=rows=>rows.find(row=>row.state!=='exited')||null;
export const liveLeadOf=(rows,storyId,role)=>liveOf(leadRowsOf(rows,storyId,role));
// Activity is progress.note only when its atMs is inside the current running stretch; a stale progress note outlives the turn.
export const activityOf=(row,runningSince,copy=CHAT_COPY)=>{const p=row&&row.progress;return p&&typeof p.note==='string'&&p.note&&Number.isFinite(p.atMs)&&p.atMs>=(runningSince||0)?p.note:copy.header.activityNone;};
const rowTable=copy=>({
 starting:{face:'starting',header:copy.header.starting,placeholder:copy.placeholder.starting},
 none:{face:'off',header:copy.header.none,placeholder:copy.placeholder.none},
 idle:{face:'idle',header:copy.header.idle,placeholder:copy.placeholder.idle},
 needs:{face:'working',header:copy.header.needs,placeholder:copy.placeholder.needs},
 unknown:{face:'off',header:copy.header.unknown,placeholder:copy.placeholder.unknown},
});
// One table per copy, built once: presence runs on every render.
const tables=new WeakMap();
const tableOf=copy=>{let table=tables.get(copy);if(!table){table=rowTable(copy);tables.set(copy,table);}return table;};
// launch: {state:'idle'|'starting'|'slow'|'joined'|'failed', failure, stuck}. failure.kind includes 'exited' (the launched lead died); stuck is a startup-stuck launched row. Failed, stuck and starting override the row table.
export function presenceOf(row,{launch,runningSince,done}={},copy=CHAT_COPY){
 let out;const by=tableOf(copy);
 if(launch&&launch.state==='failed')out={key:'failed',face:'failed',header:copy.header.failed(failureReason(launch.failure,copy)),placeholder:copy.placeholder.failed};
 else if(launch&&launch.stuck&&(launch.state==='starting'||launch.state==='slow'))out={key:'needs',...by.needs};
 else if(launch&&(launch.state==='starting'||launch.state==='slow'))out={key:'starting',...by.starting};
 else if(!row||row.state==='exited')out={key:'none',...by.none};
 else if(row.state==='running'){const activity=activityOf(row,runningSince,copy);out={key:'running',face:'working',header:copy.header.working(activity),placeholder:copy.placeholder.running,activity};}
 else if(row.state==='idle')out={key:'idle',...by.idle};
 else if(row.state==='needs-you')out={key:'needs',...by.needs};
 else out={key:'unknown',...by.unknown};
 if(done)out={key:'done',face:'off',header:copy.header.done,placeholder:copy.placeholder.done};
 return out;
}
