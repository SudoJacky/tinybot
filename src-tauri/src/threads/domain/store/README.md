# Thread Stores
<!-- tinybot-module-fingerprint: sha256:768ce860cd70a32db935d5a22fa7e2393d654d9714dcb4c112aa491be8e36ed8 -->

This module implements thread storage operations and projections used by the
thread domain.

It covers metadata, indexes, turns, checkpoints, forks, activity, memory,
subagents, queries, and conversion from stored items into runtime views.
Runtime projection preserves canonical event identity and ordering and avoids
emitting duplicate lifecycle fallbacks when a semantic event already exists.
