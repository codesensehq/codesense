// SPDX-License-Identifier: MIT
// The typed surface of the dashboard kit's chat rules: one DOM-free module (the Queued/Delivered marks and the
// needs-you card parser), served to pages as /kit/v1/chat-core.js and re-exported here as it is. The inbox
// overlay does not use it yet. A second marks rule or card parser in the app is a review finding.
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
