---
type: added
---

**Messages can say which story they are about.** Agents pass `storyId` to `send_message`, `send_role_message` and `reply` (a reply without one keeps the story of the message it answers, and your own replies do too), `read_messages` and `inbox_list` return it, and `inbox_list {story}` or a page's `inbox({story})` lists just that story's mail; an older CodeSense ignores the field.
