# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:d09c9260c6fab1cb46a4b3bb6e55c2c6edcf3ed7f5b84d104abcb8d0783348ed -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and the optional TinyOS canvas.
`ChatPage.tsx` is the route-level composition module.

Chat and TinyOS contracts, commands, and projections live in `app-core/chat`.
This folder owns React state and presentation. `TinyOsShell` and its stylesheet
remain behind the Live Canvas lazy-loading seam.

Desktop-level project and session-search dialogs keep their domain actions in
this module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.
