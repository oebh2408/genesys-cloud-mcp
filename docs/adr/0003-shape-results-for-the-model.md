# 3. Shape results for the model, not the API

## Context

Raw analytics responses are nested, use ids instead of names, report durations in milliseconds and split stats by media type. Passed through as they are, they use many tokens and the model has to do arithmetic it often gets wrong.

## Decision

Each tool returns a compact JSON object built for the question it answers: names instead of ids, seconds instead of milliseconds, rates as percentages with one decimal, and derived values (abandon rate, average speed of answer, longest wait) computed in code. Inputs take names, partial names and plain-language intervals.

## Consequences

- Answers are cheaper and more reliable.
- Some detail of the raw response is not available. Tools can be extended when a question needs more.
- Name resolution needs directory lookups, which are cached for five minutes.
