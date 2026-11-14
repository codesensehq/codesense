// SPDX-License-Identifier: MIT
// The kit's entry for window.codesense.kit.chat: scripts/gen-dashboard-kit-chat.mjs bundles this file and the modules it imports into ../chat.js.
import {mount} from './chat.js';
import {pinToBottom} from './pin.js';
import {cardAnswer,createMarkLatch,deliveryMark,isBusy,parseCard} from './chat-core.js';
import {mergeThread,newestFrom,rowsOf,sideOf} from './thread.js';
const cs=window.codesense;
if(cs&&cs.kit&&!cs.kit.chat){
 // mount(el, opts) is the only chat DOM; core is the DOM-free marks rule and card parser, also served to pages as chat-core.js; thread holds the merge rules a transport's reads follow.
 cs.kit.chat={mount,pinToBottom,core:{cardAnswer,createMarkLatch,deliveryMark,isBusy,parseCard},thread:{mergeThread,newestFrom,rowsOf,sideOf}};
}
