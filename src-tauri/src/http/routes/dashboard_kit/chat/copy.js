// SPDX-License-Identifier: MIT
// The chat's own words, in one table: every visible string of the chat comes from here. A page that needs other words passes them through mount's layout.
export const CHAT_COPY={
 lead:'Story lead',
 header:{done:'Story is done',none:'not running: your next message starts it',starting:'starting…',idle:'waiting for you',needs:'needs you in its terminal',unknown:'status unknown · its machine may be offline',working:activity=>`working · ${activity}`,failed:reason=>`couldn't start · ${reason}`,activityNone:'activity not reported'},
 placeholder:{running:"It's working; your message waits for its next step",idle:'Reply to the story lead',needs:"It's waiting on its terminal; your message waits",unknown:"Your message waits until it's reachable",none:'Message to start the story lead',starting:'Starting the story lead; more messages wait for it',failed:'Retry, or add to your kept message',done:'This story is done'},
 mark:{stuck:'Sent · waiting on its terminal',starting:'Sent · starting the lead',held:'Held · sends when the lead joins',sent:'Sent',queued:'Queued · goes to the lead at its next step',delivered:'Delivered',kept:'Not delivered · kept'},
 row:{starting:'Starting story lead…',slow:'Still starting (over 20 s)',joined:(model,activity)=>`Story lead joined · ${model} · ${activity}`,modelNone:'model not reported yet',typing:'Story lead is typing',retry:'Retry',needsTerminal:'Needs you in its terminal'},
 failure:{send:why=>`Couldn't send your message: ${why}.`,busy:'Couldn\'t start the story lead: CodeSense is at its agent limit. Try again in a moment.',denied:why=>`Couldn't start the story lead: launching was refused (${why}).`,unavailable:why=>`Couldn't start the story lead: no agent is available (${why}).`,timeout:"The story lead didn't start in 2 minutes.",exited:'The story lead stopped right after it started.',other:code=>`Couldn't start the story lead: ${code}.`,reasonBusy:'CodeSense is at its agent limit',reasonTimeout:'no join in 2 minutes',reasonExited:'it stopped right after starting'},
 terminal:'Show terminal',terminalOff:'Show terminal · not running',
 card:{needs:'Needs you',answered:'Answered',answeredInbox:'Answered in your Inbox',alsoInbox:'Also in your Inbox',from:(who,time)=>`from ${who} · ${time}`,recommended:'recommended',options:'Answers',replyLabel:'Your answer to the lead',reply:'Send answer',chose:'You chose',here:'here',inbox:'in Inbox',failed:why=>`Couldn't send your answer: ${why}.`},
 send:'Send',
 hint:'Enter to send · Shift+Enter for a new line',
 who:{you:'You'},
 composerLabel:'Message to the story lead',
 unload:'Messages you sent are still waiting for the story lead.',
 logLabel:'Story lead chat',
 chips:'Quick replies',
};
export const failureText=failure=>failure.kind==='busy'?CHAT_COPY.failure.busy:failure.kind==='denied'?CHAT_COPY.failure.denied(failure.why):failure.kind==='unavailable'?CHAT_COPY.failure.unavailable(failure.why):failure.kind==='timeout'?CHAT_COPY.failure.timeout:failure.kind==='exited'?CHAT_COPY.failure.exited:CHAT_COPY.failure.other(failure.code);
export const failureReason=failure=>failure.kind==='busy'?CHAT_COPY.failure.reasonBusy:failure.kind==='timeout'?CHAT_COPY.failure.reasonTimeout:failure.kind==='exited'?CHAT_COPY.failure.reasonExited:failure.why||failure.code;
export const modelLabel=id=>{const m=/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{6,})?$/.exec(String(id||''));return m?`${m[1][0].toUpperCase()+m[1].slice(1)} ${m[2]}${m[3]?'.'+m[3]:''}`:String(id||'');};
export const timeLabel=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
