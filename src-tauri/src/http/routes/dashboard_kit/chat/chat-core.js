// SPDX-License-Identifier: MIT
// chat-core: the chat rules with no DOM and no bridge, so the page chat and the app's typed module read them from one place. A second marks rule or card parser anywhere is a review finding.
// The Queued/Delivered rule and the needs-you card parser. Names stay unique across modules: the bundle is one scope.
// Only an idle lead takes a message at once. Anything else (running, needs you in its terminal, offline, unknown) holds it.
export const isBusy=lead=>Boolean(lead)&&lead.state!=='idle';
// Queued or Delivered for one sent message. busyAtSend is whether the lead was busy when it went (read once, at the send); lead is its sessions() row now; newestLeadAt is the time of the lead's newest thread message.
// A busy send is Queued until the lead's inbox notice says it was told after the send (mailNotice 'told' with notifiedAt at or after sentAt), or the notice came at or after the send and the unread count is back to 0 (told, then read: mailNotice is null again), or the lead has written since.
// delivery is the message's own row on the messageDelivery topic ({state:'queued'|'delivered'}), when the host pushes it: then it alone decides after the idle-send shortcut, not the roster's notice nor a later lead message. Without one (an older host, or a message the topic does not list) the roster rule above stands.
export function deliveryMark({sentAt,busyAtSend,lead,newestLeadAt=0,delivery=null}){
 if(!busyAtSend)return 'delivered';
 // Delivered means told: with the message's own row, only the row decides (a busy lead posting mid-turn has not been told yet).
 if(delivery&&typeof delivery.state==='string')return delivery.state==='delivered'?'delivered':'queued';
 if(Number.isFinite(newestLeadAt)&&newestLeadAt>sentAt)return 'delivered';
 if(!lead)return 'queued';
 const notified=Date.parse(lead.notifiedAt);
 if(!Number.isFinite(notified)||notified<sentAt)return 'queued';
 return lead.mailNotice==='told'||lead.unread===0?'delivered':'queued';
}
// Delivered latches per sent message: the lead's row going away, or other unread mail reaching it later, does not take the mark back. key names the message; the latch lives as long as the chat.
export function createMarkLatch(){
 const done=new Set();
 return (key,input)=>{
  if(done.has(key))return 'delivered';
  const mark=deliveryMark(input);
  if(mark==='delivered')done.add(key);
  return mark;
 };
}
// The card format: the question, then one line `Options: `A`, `B`, or `C`. My pick: A, because <reason>.`
// Options are backticked and plain: two to six, each short and distinct, none a `<placeholder>` that needs typing. Anything else is not a card of buttons and the page shows its text with a reply box.
const MAX_OPTIONS=6,MAX_OPTION=80;
export function parseCard(text){
 if(typeof text!=='string')return null;
 const lines=text.split(/\r?\n/);
 let at=-1;
 for(let i=lines.length-1;i>=0;i--)if(/^\s*Options:/i.test(lines[i])){at=i;break;}
 if(at<1)return null;
 const question=lines.slice(0,at).join('\n').trim();
 if(!question)return null;
 const rest=lines[at].replace(/^\s*Options:\s*/i,''),split=rest.search(/My pick:/i);
 const listed=split<0?rest:rest.slice(0,split),after=split<0?'':rest.slice(split).replace(/^My pick:\s*/i,'');
 const options=[...listed.matchAll(/`([^`]+)`/g)].map(match=>match[1].trim());
 const distinct=new Set(options.map(option=>option.toLowerCase()));
 if(options.length<2||options.length>MAX_OPTIONS||distinct.size!==options.length)return null;
 if(options.some(option=>!option||option.length>MAX_OPTION||/[<>]/.test(option)))return null;
 const said=after.replace(/`/g,'').trim().toLowerCase();
 // The pick is the longest option the "My pick:" text begins with (an option may hold a comma); one that matches none is dropped and the order stays.
 const pick=options.filter(option=>said.startsWith(option.toLowerCase())&&!/[a-z0-9]/.test(said.charAt(option.length))).sort((a,b)=>b.length-a.length)[0]||null;
 const because=pick?after.replace(/`/g,'').trim().slice(pick.length).match(/^[\s,.;:-]*because\s+([\s\S]*?)\.?\s*$/i):null;
 return {question,options:pick?[pick,...options.filter(option=>option!==pick)]:options,pick,reason:because?because[1].trim():null};
}
// The agent's trailing suggestion line: `Next: `A`, `B`` (or `Next: A · B`, for a chip with a comma in it), the last line of a message. The text above it and the chips are returned; null when the message does not end with one.
// One to four chips, each short and distinct and none a `<placeholder>`; anything else is not chips and stays text. The kit's chat and the overlay read it from here.
const MAX_NEXT=4,MAX_CHIP=80;
export function parseNext(text){
 if(typeof text!=='string')return null;
 const lines=text.split(/\r?\n/);
 let at=lines.length-1;
 while(at>=0&&!lines[at].trim())at--;
 if(at<0||!/^\s*Next:/i.test(lines[at]))return null;
 const rest=lines[at].replace(/^\s*Next:\s*/i,'');
 const quoted=[...rest.matchAll(/`([^`]+)`/g)].map(match=>match[1].trim());
 const chips=(quoted.length?quoted:rest.split('·').map(part=>part.trim())).filter(Boolean);
 const distinct=new Set(chips.map(chip=>chip.toLowerCase()));
 if(!chips.length||chips.length>MAX_NEXT||distinct.size!==chips.length)return null;
 if(chips.some(chip=>chip.length>MAX_CHIP||/[<>]/.test(chip)))return null;
 return {text:lines.slice(0,at).join('\n').trimEnd(),chips};
}
// The consent card line (spike probe 4: send_message has no card fields, so a card's step, consent class and acts travel as the last line of its text).
// `card: <step> · <class> · <act>=<label> | <act>=<label> …`, the separator ` · ` (U+00B7 with spaces). <class> is one of CONSENT_CLASSES; the act `none` is the decline. The labels are the card's buttons, and a click is a message whose text equals one label.
// The kit's chat hides the line and reads the buttons from it; scripts/setup-consent-check.mjs reads the same line from here, so a second parser anywhere is a review finding.
export const CONSENT_CLASSES=Object.freeze(['read','local-write','install-or-sign-in','external-write']);
const CARD_ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/,MAX_ID=64,SEP=' · ';
const idOk=id=>typeof id==='string'&&id.length<=MAX_ID&&CARD_ID.test(id);
const labelOk=label=>typeof label==='string'&&label.length>0&&label.length<=MAX_OPTION&&label===label.trim()&&!/[<>|\r\n]/.test(label);
const actsOk=acts=>Array.isArray(acts)&&acts.length>=1&&acts.length<=MAX_OPTIONS&&acts.every(item=>item&&idOk(item.act)&&labelOk(item.label))&&new Set(acts.map(item=>item.label.toLowerCase())).size===acts.length;
// The line for a card, or a TypeError when it would not parse back.
export function formatCardLine({step,consent,acts}){
 if(!idOk(step)||!CONSENT_CLASSES.includes(consent)||!actsOk(acts))throw new TypeError('not a card line');
 return `card: ${step}${SEP}${consent}${SEP}${acts.map(item=>`${item.act}=${item.label}`).join(' | ')}`;
}
// The card line that ends a message: {text (the message above it), step, consent, acts:[{act,label}]}, or null when the last line is not one.
export function parseCardLine(text){
 if(typeof text!=='string')return null;
 const lines=text.split(/\r?\n/);
 let at=lines.length-1;
 while(at>=0&&!lines[at].trim())at--;
 if(at<0||!lines[at].startsWith('card: '))return null;
 const rest=lines[at].slice(6).trimEnd(),first=rest.indexOf(SEP),second=first<0?-1:rest.indexOf(SEP,first+SEP.length);
 if(second<0)return null;
 const step=rest.slice(0,first),consent=rest.slice(first+SEP.length,second);
 const acts=rest.slice(second+SEP.length).split(' | ').map(part=>{const eq=part.indexOf('=');return eq<0?null:{act:part.slice(0,eq),label:part.slice(eq+1)};});
 if(!idOk(step)||!CONSENT_CLASSES.includes(consent)||acts.includes(null)||!actsOk(acts))return null;
 return {text:lines.slice(0,at).join('\n').trimEnd(),step,consent,acts};
}
// A card is answered when the thread holds the person's own row replying to it, whichever place sent it (here or the Inbox). Returns {text, at} or null.
export function cardAnswer(cardId,thread){
 const row=(Array.isArray(thread)?thread:[]).find(item=>item&&item.from==='human'&&item.inReplyTo===cardId);
 return row?{text:row.text||'',at:row.createdAtMs||0}:null;
}
// The person's pins of a chat's messages: the words the kit's chat and the app's overlay both say. A thread shows at most PIN_CAP pins, the person's and its agent's together.
export const PIN_CAP=3;
const squashSpace=text=>String(text||'').replace(/\s+/g,' ').trim();
// The first sentence of a message's first non-empty line: up to its first . ! or ?.
export function pinFirstSentence(text){const line=String(text||'').split('\n').find(l=>l.trim())||'';const end=/^.*?[.!?](?=\s|$)/.exec(line.trim());return squashSpace(end?end[0]:line);}
// "you" for the person, else the agent's name.
export const pinWho=(pinnedBy,nameOf)=>pinnedBy==='human'?'you':nameOf(pinnedBy);
// The dimmed Pin's accessible name and tooltip at the cap.
export const pinCapLabel=count=>`${count} of ${PIN_CAP} pinned`;
// The note at the cap: whose pins fill the list, the most first. Nothing is replaced.
export function pinCapNote(pins,nameOf){
 const counts=new Map();
 for(const p of pins){const who=pinWho(p.pinnedBy,nameOf);counts.set(who,(counts.get(who)||0)+1);}
 const parts=[...counts].sort((a,b)=>b[1]-a[1]).map(([who,n])=>`${n} by ${who}`).join(', ');
 return `${pinCapLabel(pins.length)} (${parts}). Unpin one to pin this.`;
}
// A message named by its first words, as the line chip and the live region show it.
export function pinFirstWords(text,words=4){const all=squashSpace(text).split(' ');return all.length<=words?all.join(' '):`${all.slice(0,words).join(' ')}…`;}
// What the polite live region says after a pin, an unpin or an Undo.
export function pinLiveText(done,title,count){const verb=done==='pinned'?'Pinned':done==='unpinned'?'Unpinned':'Restored';return `${verb} "${pinFirstWords(title)}". ${pinCapLabel(count)}.`;}
// At the cap, Pin… asks which pin to replace: the chooser's words, which the kit's chat and the app's overlay both say.
// Pin…'s accessible name and tooltip at the cap.
export const pinReplaceLabel=count=>`Pin, replacing one (${pinCapLabel(count)})`;
// The chooser's heading, which names its group.
export const pinChooserHeading=count=>`Replace a pin with this message · ${pinCapLabel(count)}`;
// A row's line: who pinned it, and when (the pin, not the message).
export const pinPinnedAtLine=(who,at)=>`Pinned by ${who} at ${at}`;
// The note and live line after a replace: "your" for the person, else the agent's name with 's.
export const pinReplacedText=(who,title)=>`Replaced ${who==='you'?'your':`${who}'s`} pin “${title}”.`;
// A row the agent added while the chooser was open, before the person arrives on it.
export const pinNewRowText=title=>`“${title}” is new. Choose it again to replace it.`;
// What changed in the list while the chooser was open.
export const pinListChangeText=(added,left)=>[...added.map(t=>`“${t}” is new.`),...left.map(t=>`“${t}” left the list.`)].join(' ');
// The agent pinned this message while the chooser was open.
export const pinPinnedMeanwhileText=who=>`${who} pinned this message. Nothing was replaced.`;
export const PIN_REPLACE_FAILED="Couldn't replace. Nothing changed.";
// The chooser when a pin left and there's room.
export const PIN_ROOM_NOW="There's room now.";
// An Undo of a replace that can't happen any more, and why.
export const PIN_UNDO_FULL="Can't undo: the list is full again.";
export const PIN_UNDO_GONE="Can't undo: that message was archived or withdrawn.";
// The replace chooser's rules, without the DOM: the kit's chooser (pin-replace.js) and the app's overlay both run them. A chooser's state is {known, last, current, change, error}:
// the pins it opened on plus the rows the person has arrived on since, the list as last drawn, the current row's message id, the line that says what changed, and a failed replace.
export const pinChooserOpen=pins=>({known:new Set(pins.map(p=>p.messageId)),last:pins,current:pins.length?pins[0].messageId:null,change:null,error:null});
// The row a key moves the current row to, of count rows (at: the current row's index), or null for any other key. From the change line (the row the person was on left), down is the first row and up the last.
export function pinChooserStep(key,at,count,fromChange){
 if(key==='ArrowDown')return fromChange?0:at+1;
 if(key==='ArrowUp')return fromChange?count-1:at-1;
 return key==='Home'?0:key==='End'?count-1:null;
}
// The person arrived on a row: it is current and known (it can now be replaced), and a failed replace's line goes.
export const pinChooserArrive=(state,id)=>({...state,known:new Set([...state.known,id]),current:id,error:null});
// Choosing a row replaces it only if the person has arrived on it: a row the agent added since the chooser opened is arrived on first and says so, so nothing is replaced unseen.
export function pinChooserChoose(state,pin,titleOf){
 if(state.known.has(pin.messageId))return {state,replace:true};
 return {state:{...pinChooserArrive(state,pin.messageId),change:pinNewRowText(titleOf(pin))},replace:false};
}
// The chooser follows the live list: null when nothing changed; {pinned} when the agent pinned this message (messageId), which closes the chooser (pinPinnedMeanwhileText says so);
// else the next state, which says what changed and drops the current row if it left.
export function pinChooserSync(state,pins,messageId,titleOf){
 const ids=new Set(pins.map(p=>p.messageId)),before=new Set(state.last.map(p=>p.messageId));
 if(ids.has(messageId)&&!before.has(messageId))return {pinned:pins.find(p=>p.messageId===messageId)};
 const added=pins.filter(p=>!before.has(p.messageId)),left=state.last.filter(p=>!ids.has(p.messageId));
 if(!added.length&&!left.length)return null;
 return {state:{...state,last:pins,current:state.current!==null&&ids.has(state.current)?state.current:null,change:pinListChangeText(added.map(titleOf),left.map(titleOf)),error:null}};
}
// Below the cap (a pin left) the chooser has room: a plain Pin pins, and it says so.
export const pinChooserRoom=count=>count>=PIN_CAP?null:PIN_ROOM_NOW;
// A message's text with its tags dropped and its entities read, as a heading or title shows it: no DOM, so the kit and the app name pins the same way.
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
function plainText(markup){return squashSpace(String(markup||'').replace(/<[^>]*>/g,' ').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(all,code)=>{if(code[0]==='#'){const n=code[1].toLowerCase()==='x'?parseInt(code.slice(2),16):parseInt(code.slice(1),10);return Number.isInteger(n)&&n>=0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):all;}const named=ENTITIES[code.toLowerCase()];return named===undefined?all:named;}));}
// An HTML message's own name: its summary, then its <title>, then its first heading, as plain text; '' when it has none. Never its markup.
export function htmlNameOf(m){
 const summary=squashSpace(m&&m.summary);
 if(summary)return summary;
 const text=String((m&&m.text)||'');
 const title=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
 if(title&&plainText(title[1]))return plainText(title[1]);
 for(const heading of text.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)){const name=plainText(heading[2]);if(name)return name;}
 return '';
}
// What a pin of this message is called. An HTML message: its own name (htmlNameOf), else "Dashboard from <sender>". Any other message: its summary, else its first sentence, else "Message from <sender>".
export function pinTitleOf(m,sender){
 if(m&&m.contentType==='html')return htmlNameOf(m)||`Dashboard from ${sender}`;
 const summary=squashSpace(m&&m.summary);
 if(summary)return summary;
 return pinFirstSentence(String((m&&m.text)||''))||`Message from ${sender}`;
}
