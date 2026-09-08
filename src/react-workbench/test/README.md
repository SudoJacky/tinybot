# Renderer Test Support
<!-- tinybot-module-fingerprint: sha256:9bd8b6af759c1fbdefdc8d395d9145c7bc1ce0d84b2a35e0fa5814603b3e2f0c -->

`test` contains shared Vitest setup used by renderer tests. It currently owns
the deterministic i18n setup required by React component tests and the
Happy DOM MutationObserver lifecycle regression test. That test starts an
isolated Node process with real garbage collection and verifies that connected
observers continue delivering mutations until explicitly disconnected. It
guards the callback-retention fix required from Happy DOM 20.11.2 onward.

Production code must not import this folder. Route-specific fixtures should
stay next to the route that owns their contract.
