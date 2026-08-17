# Architecture Decision Records

This directory records why Tinybot made durable architectural choices. Current
system behavior belongs in architecture and module documentation; an ADR keeps
the decision context, meaningful alternatives, and consequences.

Create an ADR only when a choice:

- changes a stable seam, authority, persistence model, or dependency direction;
- has realistic alternatives with different long-term consequences; and
- is likely to be questioned or revisited later.

Do not create ADRs for routine refactors, dependency upgrades, parameter
changes, or presentation details.

## Naming and status

Use `NNNN-short-title.md` with a monotonically increasing number. Valid status
values are `Proposed`, `Accepted`, `Superseded`, and `Rejected`.

Never rewrite the reasoning of an accepted ADR to match a later design. Add a
new ADR and mark the previous record `Superseded` with a link to its replacement.

## Template

```markdown
# NNNN: Decision title

Status: Proposed

## Context

What problem or pressure requires a decision?

## Decision

What will Tinybot do?

## Alternatives

What credible options were considered and why were they not selected?

## Consequences

What becomes easier, harder, or constrained?

## Related documentation

- Architecture and module links
```

Accepted ADRs must be linked from the architecture or module document affected
by the decision. An ADR is not a substitute for documenting current behavior.

