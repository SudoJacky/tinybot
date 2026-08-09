# Transport

`transport` contains transport-adjacent services used by the native runtime.
The desktop backend runs in-process; `stdio_worker/` now retains only the
capability-checked diagnostics endpoint used by the RPC router.
