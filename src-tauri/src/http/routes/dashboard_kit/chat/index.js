// SPDX-License-Identifier: MIT
// The kit's entry for window.codesense.kit.chat: scripts/gen-dashboard-kit-chat.mjs bundles this file and the modules it imports into ../chat.js.
import {mount,targetOf} from './chat.js';
import {createSendState} from './send-state.js';
import {pinToBottom} from './pin.js';
import {cardAnswer,createMarkLatch,deliveryMark,isBusy,parseCard,parseNext,CONSENT_CLASSES,formatCardLine,parseCardLine,PIN_CAP,pinCapLabel,pinCapNote,pinFirstSentence,pinFirstWords,pinLiveText,pinTitleOf,pinWho,pinReplaceLabel,pinChooserHeading,pinPinnedAtLine,pinReplacedText,pinNewRowText,pinListChangeText,pinPinnedMeanwhileText,PIN_REPLACE_FAILED,PIN_ROOM_NOW,PIN_UNDO_FULL,PIN_UNDO_GONE} from './chat-core.js';
import {mergeThread,newestFrom,rowsOf,sideOf} from './thread.js';
import {mountGifPicker,mountGifStage} from './gif-picker.js';
const cs=window.codesense;
if(cs&&cs.kit&&!cs.kit.chat){
 // mount(el, opts) is the only chat DOM; createSendState(opts) makes the send state a page keeps across mounts (mount's send option), with targetOf(opts) the peer it talks to; core is the DOM-free marks rule and card parser, also served to pages as chat-core.js; thread holds the merge rules a transport's reads follow; gifPicker(el, opts) is the GIF search popover and gifStage(el, opts) the staged GIF with its alt text.
 cs.kit.chat={mount,createSendState,targetOf,pinToBottom,core:{cardAnswer,createMarkLatch,deliveryMark,isBusy,parseCard,parseNext,CONSENT_CLASSES,formatCardLine,parseCardLine,PIN_CAP,pinCapLabel,pinCapNote,pinFirstSentence,pinFirstWords,pinLiveText,pinTitleOf,pinWho,pinReplaceLabel,pinChooserHeading,pinPinnedAtLine,pinReplacedText,pinNewRowText,pinListChangeText,pinPinnedMeanwhileText,PIN_REPLACE_FAILED,PIN_ROOM_NOW,PIN_UNDO_FULL,PIN_UNDO_GONE},thread:{mergeThread,newestFrom,rowsOf,sideOf},gifPicker:mountGifPicker,gifStage:mountGifStage};
}
