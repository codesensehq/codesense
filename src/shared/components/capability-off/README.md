# CapabilityOff: features that aren't on this OS yet

A feature that doesn't exist on every OS yet explains itself instead of failing. Everything comes
from the feature's capability key: whether it is on comes from `useCapability`, and the reason
comes from `src-tauri/platform-caps.json`. Every variant says it with the one sentence
`Not yet available on <OS>: <reason>.`

## How to gate a new feature in 3 lines

1. `src-tauri/platform-caps.json`: `{ "key": "my-feature", "macos": "on", "linux": "on", "windows": "off", "reason": "…" }`
   (and the key in `CAPABILITY_KEYS`, `src/shared/lib/capabilities.ts`)
2. In the feature: `const myFeature = useCapability("my-feature");`
3. `if (!myFeature.on) return <CapabilityOff cap="my-feature" />;` or another variant below.

The reason is plain user language. The sentence already says "not yet" and names the OS, so the
reason says neither, and it names no sockets, pipes or other internals. A test keeps
`CAPABILITY_KEYS` in step with the table, and [the guard](#the-guard) keeps OS checks out of
feature code.

## The variants

- **The feature can't run, so show why in its place.** `<CapabilityOff cap>` renders its
  children while the capability is on. Otherwise it renders the note, or `off(sentence)` for a
  surface with its own frame, such as a panel subtitle.
- **A control that starts the feature.** Put `<CapabilityOffControl cap noteId>` around the
  control and render one `<CapabilityOffNote cap id>`. The control stays visible and focusable but
  does nothing: it gets `aria-disabled`, the sentence as its tooltip, and `aria-describedby`
  pointing at the note. The control acts through `onClick` or `onSelect` (a button, a link or a
  menu item); both are replaced and their default action prevented. A control that shows the
  sentence inside itself (a menu item) passes `dim={false}` and dims only its label, so the
  sentence stays readable.
- **The feature runs with less.** `<CapabilityOffNotice cap>` is an amber notice: what changes,
  then the sentence.

With the capability on, each one renders exactly what it would without it. Before the startup
read lands, or if it fails, every capability reads as on: the backend still refuses what the OS
can't do.

## The guard

Feature code under `src/features/` doesn't check the OS (`isMac()`, `navigator.platform` and the
like) to decide whether a feature exists. [`os-checks.guard.test.ts`](./os-checks.guard.test.ts)
fails a new OS check, including an aliased import of an OS helper. Today's uses are in its
allowlist with a reason each, all presentation such as key names, shortcut glyphs and the title-bar
inset. The list only shrinks. A setting whose feature doesn't exist on this OS is hidden with
`useCapability(...).on`, not shown disabled.
