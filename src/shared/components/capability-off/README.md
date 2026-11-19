# CapabilityOff: features that aren't on this OS yet

A feature that doesn't exist on every OS yet explains itself instead of failing. Everything comes
from the feature's capability key: whether it is on comes from `useCapability`, and the reason
comes from `src-tauri/platform-caps.json`. Every variant says it with the one sentence
`Not yet available on <OS>: <reason>.`

## How to gate a new feature in 3 lines

1. Add a row to `src-tauri/platform-caps.json` with the key, a value per OS and a `reason` in
   plain user language. The sentence already says "not yet", so the reason shouldn't, and it
   names no sockets, pipes or other internals. Add the key to `CAPABILITY_KEYS` in
   `src/shared/lib/capabilities.ts` too; a test keeps the two in step.
2. In the feature: `const myFeature = useCapability("my-feature");`
3. Render a variant: `<CapabilityOff cap="my-feature">…the feature…</CapabilityOff>`.

## The variants

- **The feature can't run, so show why in its place.** `<CapabilityOff cap>` renders its
  children while the capability is on. Otherwise it renders the note, or `off(sentence)` for a
  surface with its own frame, such as a panel subtitle.
- **A control that starts the feature.** Put `<CapabilityOffControl cap noteId>` around the
  control and render one `<CapabilityOffNote cap id>`. The control stays visible and focusable but
  does nothing: it gets `aria-disabled`, the sentence as its tooltip, and `aria-describedby`
  pointing at the note.
- **The feature runs with less.** `<CapabilityOffNotice cap>` is an amber notice: what changes,
  then the sentence.

With the capability on, each one renders exactly what it would without it. Before the startup
read lands, or if it fails, every capability reads as on: the backend still refuses what the OS
can't do.

## The guard

Feature code under `src/features/` doesn't check the OS (`isMac()`, `navigator.platform` and the
like) to decide whether a feature exists. `os-checks.guard.test.ts` in this folder fails a new OS
check. Today's presentation uses, such as key names, shortcut glyphs and the title-bar inset, are
in its allowlist with a reason each. The list only shrinks.
