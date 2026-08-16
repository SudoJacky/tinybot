# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:5277000fb93691718a9fa7273f0c1e881a530021d35a7c92010830e6bee1f243 -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and the optional TinyOS canvas.
`ChatPage.tsx` is the route-level composition module.

Chat and TinyOS contracts, commands, and projections live in `app-core/chat`.
This folder owns React state and presentation. `TinyOsShell` and its stylesheet
remain behind the Live Canvas lazy-loading seam.

Desktop-level project and session-search dialogs keep their domain actions in
this module while delegating modal focus, keyboard, dismissal, and scroll-lock
behavior to `components/ui/useModalDialog`.
