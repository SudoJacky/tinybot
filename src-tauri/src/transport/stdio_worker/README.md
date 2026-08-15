# Worker Diagnostics
<!-- tinybot-module-fingerprint: sha256:7c7aaeec2f0233b062a75027d6a921a27517074ef9bd3ca2fce600d4727ab789 -->

The desktop backend runs in-process. This module retains the capability-checked
diagnostics endpoint used by the RPC router; the obsolete standard-I/O worker
codec, connection, process manager, and status model have been removed.
