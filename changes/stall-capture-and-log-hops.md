---
type: fixed
---

**The app no longer freezes itself while recording a stall or its command rates.** The stall sample starts without forking the whole app, so other threads no longer wait on the memory allocator while it starts. The once-a-minute command-rate line is built and written on its own thread instead of by whichever call ends the minute. Release builds copy only warnings and errors into the developer console.
