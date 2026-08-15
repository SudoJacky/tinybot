# Renderer Library
<!-- tinybot-module-fingerprint: sha256:c67a904d102a0edca23014009dd9003f98f09d25e0c9223b8ff74d9088f8ba92 -->

`lib` contains small, renderer-only presentation helpers shared by frontend
modules. Helpers here should be pure and independent of React route state.

Protocol normalization, native transport, and domain projections belong in
their owning `app-core` or adapter modules rather than in a general utility
folder.
