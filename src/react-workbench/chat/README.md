# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:26928f6bafa2ff22fe6da6631b55785146d09c32797c82cf38ede03f7641ffcd -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and detail drawers.
`ChatPage.tsx` is the route-level composition module.

Chat contracts, commands, and projections live in `app-core/chat`. This folder
owns React state and presentation. Browser runtime snapshots are retained by the
session runtime for the native WebView2 integration; the retired TinyOS desktop
surface is not part of this route.

Desktop-level project and session-search dialogs keep their domain actions in
this module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.
