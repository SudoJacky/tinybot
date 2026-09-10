# Renderer Library
<!-- tinybot-module-fingerprint: sha256:4adf5280e5fb49782a90f0979cfe3981982b641c7b0008f699be143947386174 -->

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

`AppToast` provides a window-level transient notification host shared by the main
shell and pet quick chat. New notices replace old ones; ordinary/error messages
remain for five/eight seconds, pause while hovered or focused, and fade out over
220 ms. Portals avoid route clipping, reduced-motion removes movement, and timers
are cleaned up when messages are replaced.
