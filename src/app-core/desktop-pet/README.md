# Desktop Pet State
<!-- tinybot-module-fingerprint: sha256:5ad53936178ab38ab2c0ad62d9cd8c3c91072a09ecef2a9d26c94f0eae477fc0 -->

`desktop-pet` owns the framework-independent pet preferences and Windows
window geometry. A persisted position is the pet window center in physical
desktop pixels, so negative coordinates remain valid for monitors placed to
the left of the primary display. Storage version `v2` marks that coordinate
contract. When `v1` viewport-relative preferences are encountered, visibility
and size migrate while position is discarded so the native host can choose a
safe physical-desktop default.

`desktopPetWindowGeometry` converts that center to native top-left coordinates,
keeps the full window inside the selected monitor work area, and chooses a
bottom-right default that avoids the taskbar. React rendering and Tauri window
operations remain outside this module.

`desktopPetQuickChatGeometry` positions the companion quick-chat window beside
the pet. It prefers the pet's right side, falls back to the left when needed,
and clamps the full panel to the current monitor work area, including monitors
with negative desktop coordinates.
