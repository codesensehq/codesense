---
type: added
---

**Key passphrases on Linux.** Adding a machine with "Key + passphrase" now works on Linux: a system dialog (zenity, kdialog or your `SSH_ASKPASS` program) asks for the passphrase, and CodeSense keeps it in Secret Service so you aren't asked again. The passphrase never enters the app's window.
