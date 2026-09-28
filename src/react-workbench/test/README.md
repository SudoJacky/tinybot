# Renderer Test Support
<!-- tinybot-module-fingerprint: sha256:6b5111ab02973d196f9b58f9d5044e4320252eeadbe9e58132d1bd52df602e37 -->

`test` contains shared Vitest setup used by renderer tests. It currently owns
the deterministic i18n setup required by React component tests and the
Happy DOM MutationObserver lifecycle regression test. That test starts an
isolated Node process with real garbage collection and verifies that connected
observers continue delivering mutations until explicitly disconnected. It
guards the callback-retention fix required from Happy DOM 20.11.2 onward.

`settingsStoreFixture.ts` supplies the required config and Provider methods for
component tests. Unexpected saves throw until the test explicitly supplies the
expected result, so incomplete mocks cannot silently skip persistence.

Production code must not import this folder. Route-specific fixtures should
stay next to the route that owns their contract.
