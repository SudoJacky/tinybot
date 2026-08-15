# Session UI State
<!-- tinybot-module-fingerprint: sha256:639a55537c8b2709d7faacaa59df1f8a4f1b2027876d033417ff13064cb7b9e5 -->

`sessions` contains focused state helpers for transient session interactions,
such as the conversation deletion transition.

Durable session data and mutations remain behind `SessionStore`; this module
must not duplicate backend session authority or chat runtime state.
