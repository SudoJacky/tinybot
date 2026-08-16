# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:ed6b157e6f6dc1b8735b5f8257709fc0fd580ba044a8469cbd32e13f72bb2f55 -->

`settings` owns the Settings route, its navigation, pages, sheets, appearance
and language contexts, and form presentation. `SettingsRoute.tsx` is loaded as
an optional desktop route together with `SettingsRoute.css`.

Settings contracts, metadata, validation, value semantics, and persistence
patches live in `app-core/settings`. Native reads and writes are exposed through
the Settings store adapter.

`SettingsChoiceList.tsx` is the canonical fixed-choice control for settings
pages. App preferences, appearance fonts, Agent defaults, and fixed config
options reuse its trigger, popover, selected state, and keyboard navigation
instead of rendering platform-native select menus.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.
