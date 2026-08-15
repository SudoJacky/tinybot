# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:bfb41c2b4a9dc40a5078977534b3d6ba2f9fece099e389adc228a1ac630354c3 -->

`adapters` implements renderer store interfaces over Tinybot's native and
app-core modules. It owns event projection and the Settings, Tools, and
Workspace store adapters used by `createDesktopAppServices()`.

Adapters may translate transport data into renderer contracts, but they do not
render React views or become a second authority for chat, settings, or
workspace state.
