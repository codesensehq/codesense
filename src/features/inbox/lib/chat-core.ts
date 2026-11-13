// SPDX-License-Identifier: MIT
// The overlay's chat rules are the dashboard kit's: one DOM-free module (the Queued/Delivered marks and the
// needs-you card parser), served to pages as /kit/v1/chat-core.js and imported here as it is. A second marks
// rule or card parser in the app is a review finding.
export {
  cardAnswer,
  createMarkLatch,
  deliveryMark,
  isBusy,
  parseCard,
} from "../../../../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.js";
export type {
  ChatCard,
  ChatLeadRow,
  ChatThreadRow,
} from "../../../../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.d.ts";
