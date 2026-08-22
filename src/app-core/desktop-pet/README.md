# Desktop Pet State
<!-- tinybot-module-fingerprint: sha256:c39a79a5761ff9437fb846542aa906f67be28b797229e000ae7e625f279cbf9f -->

`desktop-pet` owns the framework-independent pet preferences and Windows
window geometry. A persisted position is the pet window center in physical
desktop pixels, so negative coordinates remain valid for monitors placed to
the left of the primary display.

`desktopPetWindowGeometry` converts that center to native top-left coordinates,
keeps the full window inside the selected monitor work area, and chooses a
bottom-right default that avoids the taskbar. React rendering and Tauri window
operations remain outside this module.
