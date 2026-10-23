# 2. Demo org behind the same client interface

## Context

Most people who want to try an MCP server for Genesys Cloud do not have an org they can point it at, and those who do need an OAuth client approved first. Tests also need data that does not depend on a live org.

## Decision

Tools talk to a `PlatformClient` with one `request(method, path, options)` method. `HttpPlatformClient` sends real requests. `DemoPlatformClient` answers the same paths with the same response shapes from a simulated center.

The simulation generates arrivals per queue on a daily curve and routes each one to the first free agent on shift, with short breaks. Waits and abandons follow from that, so the numbers are consistent across tools: the offered count from the aggregates query equals the number of conversations the details query returns for the same queue and interval. Each day is generated from a fixed seed.

## Consequences

- Tools are tested end to end without mocks of individual responses.
- The demo has to follow the real response shapes; when a tool starts using a new field, the demo needs it too.
- The demo is not a full emulator. It implements the filters and metrics the tools use.
