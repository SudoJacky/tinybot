# Worker Diagnostics

The desktop backend runs in-process. This module retains the capability-checked
diagnostics endpoint used by the RPC router; the obsolete standard-I/O worker
codec, connection, process manager, and status model have been removed.
