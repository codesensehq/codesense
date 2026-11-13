// SPDX-License-Identifier: MIT
// Presence: one state from the lead's sessions() row, shared by the face, the header line and the composer placeholder (AC7).
import {CHAT_COPY,failureReason} from './copy.js';
// Every row of this story's lead (a relaunch lists more than one) and the one that is live (any state but exited).
export const leadRowsOf=(rows,storyId,role)=>(Array.isArray(rows)?rows:[]).filter(row=>row.story===storyId&&row.role===role);
// The one live rule: the first row that has not exited (any other state counts as live to presence).
export const liveOf=rows=>rows.find(row=>row.state!=='exited')||null;
export const liveLeadOf=(rows,storyId,role)=>liveOf(leadRowsOf(rows,storyId,role));
// Activity is progress.note only when its atMs is inside the current running stretch; a stale progress outlives the turn (spike g).
export const activityOf=(row,runningSince)=>{const p=row&&row.progress;return p&&typeof p.note==='string'&&p.note&&Number.isFinite(p.atMs)&&p.atMs>=(runningSince||0)?p.note:CHAT_COPY.header.activityNone;};
const by={
 starting:{face:'starting',header:CHAT_COPY.header.starting,placeholder:CHAT_COPY.placeholder.starting},
 none:{face:'off',header:CHAT_COPY.header.none,placeholder:CHAT_COPY.placeholder.none},
 idle:{face:'idle',header:CHAT_COPY.header.idle,placeholder:CHAT_COPY.placeholder.idle},
 needs:{face:'working',header:CHAT_COPY.header.needs,placeholder:CHAT_COPY.placeholder.needs},
 unknown:{face:'off',header:CHAT_COPY.header.unknown,placeholder:CHAT_COPY.placeholder.unknown},
};
// launch: {state:'idle'|'starting'|'slow'|'joined'|'failed', failure, stuck}. failure.kind includes 'exited' (the launched lead died); stuck is a startup-stuck launched row. Failed, stuck and starting override the row table.
export function presenceOf(row,{launch,runningSince,done}={}){
 let out;
 if(launch&&launch.state==='failed')out={key:'failed',face:'failed',header:CHAT_COPY.header.failed(failureReason(launch.failure)),placeholder:CHAT_COPY.placeholder.failed};
 else if(launch&&launch.stuck&&(launch.state==='starting'||launch.state==='slow'))out={key:'needs',...by.needs};
 else if(launch&&(launch.state==='starting'||launch.state==='slow'))out={key:'starting',...by.starting};
 else if(!row||row.state==='exited')out={key:'none',...by.none};
 else if(row.state==='running'){const activity=activityOf(row,runningSince);out={key:'running',face:'working',header:CHAT_COPY.header.working(activity),placeholder:CHAT_COPY.placeholder.running,activity};}
 else if(row.state==='idle')out={key:'idle',...by.idle};
 else if(row.state==='needs-you')out={key:'needs',...by.needs};
 else out={key:'unknown',...by.unknown};
 if(done)out={key:'done',face:'off',header:CHAT_COPY.header.done,placeholder:CHAT_COPY.placeholder.done};
 return out;
}
