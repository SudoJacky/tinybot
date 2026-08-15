# Renderer Test Support
<!-- tinybot-module-fingerprint: sha256:d091788f925e0bb46fa12b2f87bce93e27ffa4d777e5681e86db33858851b2c7 -->

`test` contains shared Vitest setup used by renderer tests. It currently owns
the deterministic i18n setup required by React component tests.

Production code must not import this folder. Route-specific fixtures should
stay next to the route that owns their contract.
