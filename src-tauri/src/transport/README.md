# Transport
<!-- tinybot-module-fingerprint: sha256:c64758babc5323d500ecb1a925eb919912f8273330fd92aafd7a240a4ecb0180 -->

`transport` contains transport-adjacent services used by the native runtime.
The desktop backend runs in-process; `stdio_worker/` now retains only the
capability-checked diagnostics endpoint used by the RPC router.
