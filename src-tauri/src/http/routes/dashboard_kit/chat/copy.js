// SPDX-License-Identifier: MIT
// The chat's own words, in one table: every visible string of the chat comes from here. A page that needs other words passes them through mount's layout.
export const CHAT_COPY={
 lead:'Story lead',
 header:{done:'Story is done',none:'not running: your next message starts it',starting:'starting…',idle:'waiting for you',needs:'needs you in its terminal',unknown:'status unknown · its machine may be offline',working:activity=>`working · ${activity}`,failed:reason=>`couldn't start · ${reason}`,activityNone:'activity not reported'},
 placeholder:{running:"It's working; your message waits for its next step",idle:'Reply to the story lead',needs:"It's waiting on its terminal; your message waits",unknown:"Your message waits until it's reachable",none:'Message to start the story lead',starting:'Starting the story lead; more messages wait for it',failed:'Retry, or add to your kept message',done:'This story is done'},
 mark:{stuck:'Sent · waiting on its terminal',starting:'Sent · starting the lead',held:'Held · sends when the lead joins',sent:'Sent',queued:'Queued · goes to the lead at its next step',delivered:'Delivered',kept:'Not delivered · kept'},
 row:{htmlFrom:who=>`Dashboard from ${who}`,htmlOpen:'Open',htmlClose:'Close',starting:'Starting story lead…',slow:'Still starting (over 20 s)',joined:(model,activity)=>`Story lead joined · ${model} · ${activity}`,modelNone:'model not reported yet',typing:'Story lead is typing',working:'Working…',retry:'Retry',needsTerminal:'Needs you in its terminal',unread:"Couldn't load the conversation.",loading:'Loading the conversation…',stale:time=>`Couldn't refresh · ${time}`,to:name=>`To ${name}`},
 failure:{send:why=>`Couldn't send your message: ${why}.`,busy:'Couldn\'t start the story lead: CodeSense is at its agent limit. Try again in a moment.',denied:why=>`Couldn't start the story lead: launching was refused (${why}).`,unavailable:why=>`Couldn't start the story lead: no agent is available (${why}).`,timeout:"The story lead didn't start in 2 minutes.",exited:'The story lead stopped right after it started.',other:code=>`Couldn't start the story lead: ${code}.`,reasonBusy:'CodeSense is at its agent limit',reasonTimeout:'no join in 2 minutes',reasonExited:'it stopped right after starting'},
 terminal:'Show terminal',terminalOff:'Show terminal · not running',
 card:{needs:'Needs you',answered:'Answered',answeredInbox:'Answered in your Inbox',alsoInbox:'Also in your Inbox',from:(who,time)=>`from ${who} · ${time}`,recommended:'recommended',why:(lead,pick,reason)=>`${lead} recommends ${pick} because ${String(reason).replace(/^because\s+/i,'').replace(/[.!?\s]+$/,'')}.`,consent:{read:'read','local-write':'local change','install-or-sign-in':'install or sign-in','external-write':'external write'},options:'Answers',replyLabel:'Your answer to the lead',reply:'Send answer',chose:'You chose',here:'here',inbox:'in Inbox',failed:why=>`Couldn't send your answer: ${why}.`},
 send:'Send',
 hint:'Enter to send · Shift+Enter for a new line',
 who:{you:'You'},
 composerLabel:'Message to the story lead',
 unload:'Messages you sent are still waiting for the story lead.',
 unloadKept:"Some messages weren't sent.",
 logLabel:'Story lead chat',
 chips:'Quick replies',
 chipEdit:{label:text=>`Edit “${text}” before sending`,title:'Edit before sending'},
 pin:{pin:'Pin',unpin:'Unpin',actions:'Message actions',by:who=>`Pinned by ${who}`,unpinned:'Unpinned.',undo:'Undo',showPins:'Show pins',failed:"Couldn't pin. Try again. If it keeps failing, reload the page.",unpinFailed:"Couldn't unpin. Try again. If it keeps failing, reload the page.",tryAgain:'Try again',pinMore:'Pin…',cancel:'Cancel',isNew:'New',replace:'Replace',undoReplaceFailed:"Couldn't undo the replace. Try again. If it keeps failing, reload the page."},
};
export const failureText=(failure,copy=CHAT_COPY)=>failure.kind==='busy'?copy.failure.busy:failure.kind==='denied'?copy.failure.denied(failure.why):failure.kind==='unavailable'?copy.failure.unavailable(failure.why):failure.kind==='timeout'?copy.failure.timeout:failure.kind==='exited'?copy.failure.exited:failure.kind==='refused'&&copy.failure.refused?copy.failure.refused(failure.why):copy.failure.other(failure.code);
export const failureReason=(failure,copy=CHAT_COPY)=>failure.kind==='busy'?copy.failure.reasonBusy:failure.kind==='timeout'?copy.failure.reasonTimeout:failure.kind==='exited'?copy.failure.reasonExited:failure.kind==='refused'&&!copy.failure.refused?failure.code:failure.why||failure.code;
// A page's own words: its table over CHAT_COPY, one level deep (a section it names keeps the keys it leaves out).
export const mergeCopy=(over={})=>Object.fromEntries(Object.entries({...CHAT_COPY,...over}).map(([key,value])=>[key,value&&typeof value==='object'&&!Array.isArray(value)&&CHAT_COPY[key]&&typeof CHAT_COPY[key]==='object'?{...CHAT_COPY[key],...value}:value]));
export const modelLabel=id=>{const m=/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{6,})?$/.exec(String(id||''));return m?`${m[1][0].toUpperCase()+m[1].slice(1)} ${m[2]}${m[3]?'.'+m[3]:''}`:String(id||'');};
export const timeLabel=ms=>Number.isFinite(ms)?new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):'';
// Each GIF provider's words in the picker, the one mirror of src/shared/lib/gif-providers.ts (a parity test keeps them equal): its name, its search box's placeholder and its attribution line.
export const GIF_PROVIDER_COPY={
 giphy:{name:'GIPHY',searchPlaceholder:'Search GIPHY',poweredBy:'Powered By GIPHY'},
 klipy:{name:'KLIPY',searchPlaceholder:'Search KLIPY',poweredBy:'Powered by KLIPY'},
};
// The GIF picker's and the staged GIF's words. A provider's name comes in as `name`.
export const GIF_COPY={
 dialog:'GIF search',close:'Close GIF search',clear:'Clear search',results:'GIF results',searchLabel:'Search GIFs',
 start:name=>`Search ${name}, or start with`,starters:['thumbs up','thank you','ship it','on it'],
 typeMore:'Type 2+ letters',escClose:'Esc close',searching:name=>`Searching ${name}…`,
 hover:'click to add',focus:'Enter add · Esc close',untitled:'Untitled GIF',failedStill:'Preview unavailable',
 loading:'Checking GIF search…',
 consent:{big:name=>`Search GIFs with ${name}?`,body:name=>`What you type in this box is sent to ${name}, a third-party service, to find GIFs. Nothing leaves this Mac until you allow it.`,fine:'Asked once per provider. To turn GIF search off: Settings › Messaging › GIF search.',allow:'Allow search',notNow:'Not now'},
 settingsPath:'Settings › Messaging › GIF search',openSettings:'Open Settings',tryAgain:'Try again',
 state:{
  noProvider:{big:'Turn on GIF search and add a key',body:()=>'GIF search is off, or it has no key yet.'},
  invalidKey:{big:'The key was refused',body:name=>`${name} didn't accept the key. Replace it in Settings to search again.`},
  mediaOff:{big:'GIFs are off for this team',body:()=>"This team's remote media is off (media.remote: off in its config/inbox.yml), so no GIFs load."},
  keychainUnavailable:{big:name=>`Couldn't read your ${name} key`,body:()=>"The keychain didn't answer, or this Mac has no secret store. If it's locked, unlock it, then try again."},
  rateLimited:{big:'GIF search limit reached',body:(_name,wait)=>`You and your agents share an hourly limit on GIF searches. Try again in ${wait}.`},
  providerUnavailable:{big:name=>`${name} isn't answering`,body:()=>"The search didn't go through. Your message is safe."},
  badQuery:{big:'Try different words',body:name=>`${name} couldn't search for that.`},
  failed:{big:"Couldn't search for GIFs",body:(_name,_wait,why)=>why},
 },
 noResults:{big:query=>`No GIFs for “${query}”`,body:'Try fewer or different words.'},
 wait:seconds=>seconds>=90?`${Math.ceil(seconds/60)} min`:`${Math.max(1,Math.ceil(seconds))} s`,
 stage:{remove:'Remove GIF',thumb:alt=>`GIF: ${alt||'no alt text'}. Backspace removes it.`,alt:'Alt text',required:'required',placeholder:'Describe the GIF for agents',help:name=>`From ${name}'s title. Agents read this instead of the GIF.`,missing:'Add alt text to send. Agents only see this text.'},
};
