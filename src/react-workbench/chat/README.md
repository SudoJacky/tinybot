# Chat Workbench
<!-- tinybot-module-fingerprint: sha256:facd064b41f5d5d204f0fb2960aa7d30403b1e104055e0351b5162428e05d43d -->

`chat` owns the desktop Chat route, including session navigation, submission,
canonical timeline presentation, the composer, and the optional TinyOS canvas.
`ChatPage.tsx` is the route-level composition module.

Chat and TinyOS contracts, commands, and projections live in `app-core/chat`.
This folder owns React state and presentation. `TinyOsShell` and its stylesheet
remain behind the Live Canvas lazy-loading seam.
