# Desktop Pet State
<!-- tinybot-module-fingerprint: sha256:085026479930fe0c663e71d70fcea86a51120b37fa04403b89f2e67248f1d0b9 -->

`desktop-pet` owns the framework-independent pet preferences and Windows
window geometry and appearance choice. A persisted position is the pet window center in physical
desktop pixels, so negative coordinates remain valid for monitors placed to
the left of the primary display. Storage version `v3` adds the `classic` and
`dimensional` appearance contract. Version `v2` physical coordinates migrate
unchanged and receive the dimensional default. When `v1` viewport-relative
preferences are encountered, visibility and size migrate while position is
discarded so the native host can choose a safe physical-desktop default.
After a legacy value is parsed successfully, Tinybot writes the migrated `v3`
record and removes both legacy storage keys. Invalid legacy JSON is retained so
its existing restore diagnostic remains actionable.

`desktopPetWindowGeometry` converts that center to native top-left coordinates,
keeps the full window inside the selected monitor work area, and chooses a
bottom-right default that avoids the taskbar. React rendering and Tauri window
operations remain outside this module.

`desktopPetQuickChatGeometry` positions the companion quick-chat window beside
the pet. It prefers the pet's right side, falls back to the left when needed,
and clamps the full panel to the current monitor work area, including monitors
with negative desktop coordinates.
