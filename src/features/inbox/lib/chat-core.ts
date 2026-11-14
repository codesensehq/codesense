// SPDX-License-Identifier: MIT
// The typed surface of the dashboard kit's chat rules: one DOM-free module (the Queued/Delivered marks, the
// needs-you card parser and the Next-line chip parser), served to pages as /kit/v1/chat-core.js and re-exported here as it is. The inbox
// overlay reads its Queued/Delivered marks from it. A second marks rule or card parser in the app is a review finding.
export {
  CONSENT_CLASSES,
  cardAnswer,
  createMarkLatch,
  deliveryMark,
  formatCardLine,
  isBusy,
  parseCard,
  parseCardLine,
  parseNext,
  type ChatCard,
  type ChatCardAct,
  type ChatCardLine,
  type ChatConsent,
  type ChatNext,
  type ChatLeadRow,
  type ChatThreadRow,
} from "../../../../src-tauri/src/http/routes/dashboard_kit/chat/chat-core.js";
