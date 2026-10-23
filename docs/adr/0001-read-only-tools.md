# 1. Read-only tools only

## Context

An assistant connected to a contact center can be asked anything, including things like "move these calls to another queue" or "log this agent out". The Platform API allows all of that with the right permissions. Mistakes there affect customers immediately and cannot be undone.

## Decision

The server only reads. Every request passes through `assertReadOnly`, which allows `GET` and a fixed list of analytics query endpoints that use `POST` to send a query body. Anything else throws before the request is sent. Tools are annotated with `readOnlyHint: true`.

## Consequences

- The server is safe to give to people who should see data but not change configuration.
- Write operations, if ever added, need a separate server or an explicit opt-in, not a new tool in this one.
- Adding a new query endpoint means adding it to the allowlist on purpose.
