# Renderer Library
<!-- tinybot-module-fingerprint: sha256:fd50037e5c51e14ab5e8663cb245fcf591083ffeaf1b8b241c5b79d316769aec -->

`lib` contains small, renderer-only presentation helpers shared by frontend
modules. Formatting helpers are pure; presentation hooks do not own route state.

`useExitPresence` retains closing content within its owner scope until the
owning CSS transitions finish. Callers supply the live value and a stable
transition reader, and independently enforce logical visibility, inertness and
native surface visibility. Reopening or changing scope invalidates pending
removal. `elementTransitions` selects only an element's own named CSS
transitions, excluding descendant cursors/spinners; cancellation rechecks the
current transitions, while unexpected failures remain observable.

Protocol normalization, native transport, and domain projections belong in
their owning `app-core` or adapter modules rather than in a general utility
folder.
