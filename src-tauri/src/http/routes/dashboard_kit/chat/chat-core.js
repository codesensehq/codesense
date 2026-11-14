// SPDX-License-Identifier: MIT
// chat-core: the chat rules with no DOM and no bridge, so the page chat and the app's typed module read them from one place. A second marks rule or card parser anywhere is a review finding.
// The Queued/Delivered rule and the needs-you card parser. Names stay unique across modules: the bundle is one scope.
// Only an idle lead takes a message at once. Anything else (running, needs you in its terminal, offline, unknown) holds it.
export const isBusy=lead=>Boolean(lead)&&lead.state!=='idle';
// Queued or Delivered for one sent message. busyAtSend is whether the lead was busy when it went (read once, at the send); lead is its sessions() row now; newestLeadAt is the time of the lead's newest thread message.
// A busy send is Queued until the lead's inbox notice says it was told after the send (mailNotice 'told' with notifiedAt at or after sentAt), or the notice came at or after the send and the unread count is back to 0 (told, then read: mailNotice is null again), or the lead has written since.
export function deliveryMark({sentAt,busyAtSend,lead,newestLeadAt=0}){
 if(!busyAtSend)return 'delivered';
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
// A card is answered when the thread holds the person's own row replying to it, whichever place sent it (here or the Inbox). Returns {text, at} or null.
export function cardAnswer(cardId,thread){
 const row=(Array.isArray(thread)?thread:[]).find(item=>item&&item.from==='human'&&item.inReplyTo===cardId);
 return row?{text:row.text||'',at:row.createdAtMs||0}:null;
}
