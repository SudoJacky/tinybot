# Native Renderer Adapters
<!-- tinybot-module-fingerprint: sha256:8a62a75ed97d908abac2bad7c283aa796597abdc5ec569124eb33a9520747d82 -->

`native` contains typed adapters for Tauri commands and events used by the
desktop renderer. Each file owns one native capability, such as Threads,
Workspace, Browser, Settings, Plugins, or Memory.

Adapters preserve native failures and normalize only their transport contract.
React state and product projections remain in the workbench and other app-core
modules. `nativeBackendContract` guards frontend/backend contract parity.
