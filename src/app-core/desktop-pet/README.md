# Desktop Pet State
<!-- tinybot-module-fingerprint: sha256:f9437e667cd18b570393b205bca92a36eff7d8cdc439f02575d8f9d8ea5e19b5 -->

`desktop-pet` owns the framework-independent pet preferences and Windows
window geometry. A persisted position is the pet window center in physical
desktop pixels, so negative coordinates remain valid for monitors placed to
the left of the primary display.

`desktopPetWindowGeometry` converts that center to native top-left coordinates,
keeps the full window inside the selected monitor work area, and chooses a
bottom-right default that avoids the taskbar. React rendering and Tauri window
operations remain outside this module.

`desktopPetQuickChatGeometry` positions the companion quick-chat window beside
the pet. It prefers the pet's right side, falls back to the left when needed,
and clamps the full panel to the current monitor work area, including monitors
with negative desktop coordinates.
