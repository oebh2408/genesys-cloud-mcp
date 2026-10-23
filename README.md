# genesys-cloud-mcp

[![ci](https://github.com/oebh2408/genesys-cloud-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/oebh2408/genesys-cloud-mcp/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Genesys Cloud. It lets an AI assistant answer questions about queues, agents and conversations using the Platform API, without being able to change anything in the org.

It ships with a demo contact center, so you can try it in an MCP client without a Genesys Cloud account.

## What you can ask

- How are the queues doing right now? Is anyone waiting?
- Which queue missed its service level yesterday, and in which hours?
- Who handled the most interactions this week and what is their average handle time?
- Show me the abandoned chats from the last 4 hours that waited more than two minutes.
- Walk me through conversation `284d0a28-...`: how long did the customer wait, was there a hold, how did it end?

## Tools

| Tool | What it returns | API used |
| --- | --- | --- |
| `list_queues` | Queues and member counts | `GET /api/v2/routing/queues` |
| `get_queue_status` | Waiting, longest wait, interacting, agents on queue by routing status | `POST /api/v2/analytics/queues/observations/query` |
| `get_queue_performance` | Offered, answered, abandoned, abandon rate, service level, ASA, handle, talk, hold and ACW averages; optional time buckets | `POST /api/v2/analytics/conversations/aggregates/query` |
| `list_agents` | Agents with presence and routing status, filtered by queue, status or name | `GET /api/v2/users`, `GET /api/v2/routing/queues/{id}/members` |
| `get_agent_performance` | Handled interactions and average handle, talk, hold and ACW per agent | `POST /api/v2/analytics/conversations/aggregates/query` |
| `search_conversations` | One line per conversation, filtered by queue, agent, media type, direction, outcome, wait or duration | `POST /api/v2/analytics/conversations/details/query` |
| `get_conversation` | Timeline of one conversation: queue time, talk, hold, after-call work, wrap-up, who disconnected | `GET /api/v2/analytics/conversations/{id}/details` |

There is also a `queue_health_report` prompt that asks the model to combine the live status and today's hourly trend into a short report.

Queues and agents can be given by name; partial names work (`"chat"` finds `Chat Support`). Intervals accept `today`, `yesterday`, `this_week`, `last 30m`, `last 4h`, `last 7d` or an ISO-8601 interval. Calendar words use `GENESYS_TIMEZONE`.

Results are JSON with names instead of ids, durations in seconds and rates as percentages, so the model does not have to convert milliseconds or look up ids.

## Try it with the demo contact center

The demo is a fictional center with six queues (voice and chat) and 25 agents. Calls arrive on a daily curve and are routed to the first free agent who is on shift, so waits, abandons and service level come out of the load and staffing. History covers the last five weeks and live status changes as the day goes on.

In Claude Desktop, add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "genesys-cloud-demo": {
      "command": "npx",
      "args": ["-y", "github:oebh2408/genesys-cloud-mcp", "--demo"]
    }
  }
}
```

In Claude Code:

```sh
claude mcp add genesys-cloud-demo -- npx -y github:oebh2408/genesys-cloud-mcp --demo
```

Or from a clone:

```sh
npm install
npm run try                 # calls a few tools and prints the results
npm run inspector           # opens the MCP Inspector against the demo
```

Sample output of `get_queue_performance` for the demo chat queue:

```json
{
  "queue": "Chat Support",
  "offered": 165,
  "answered": 150,
  "abandoned": 15,
  "abandonRatePercent": 9.1,
  "serviceLevelPercent": 80.2,
  "avgSpeedOfAnswerSeconds": 19,
  "longestWaitSeconds": 508,
  "avgHandleSeconds": 626,
  "avgHoldSeconds": 74,
  "avgAcwSeconds": 36,
  "transferred": 8
}
```

## Connect to a real org

1. In Genesys Cloud, create a role with view permissions only. The tools need:
   - `analytics:conversationAggregate:view`
   - `analytics:conversationDetail:view`
   - `analytics:queueObservation:view`
   - `routing:queue:view`
   - `routing:wrapupCode:view`
   - permission to view users, their presence and routing status

   Permission names change from time to time; check them in Admin > Roles / Permissions. A 403 from a tool tells you which request was refused.
2. Create an OAuth client with the **Client Credentials** grant and assign it that role, restricted to the divisions you want the assistant to see.
3. Configure the server:

```json
{
  "mcpServers": {
    "genesys-cloud": {
      "command": "npx",
      "args": ["-y", "github:oebh2408/genesys-cloud-mcp"],
      "env": {
        "GENESYS_CLIENT_ID": "...",
        "GENESYS_CLIENT_SECRET": "...",
        "GENESYS_REGION": "mypurecloud.com",
        "GENESYS_TIMEZONE": "America/Bogota"
      }
    }
  }
}
```

| Variable | Default | Description |
| --- | --- | --- |
| `GENESYS_CLIENT_ID` | | OAuth client id |
| `GENESYS_CLIENT_SECRET` | | OAuth client secret |
| `GENESYS_REGION` | | Region domain: `mypurecloud.com`, `usw2.pure.cloud`, `mypurecloud.ie`, `mypurecloud.de`, `mypurecloud.com.au`, ... |
| `GENESYS_TIMEZONE` | `UTC` (demo: `America/Bogota`) | IANA time zone for `today`, `yesterday` and `this_week` |
| `GENESYS_REDACT` | `true` | Mask customer phone numbers, emails and names |
| `GENESYS_DEMO` | `false` | Same as `--demo` |

## Safety

- **Read-only by construction.** Every request goes through one check that allows `GET` and the four analytics query endpoints, and refuses anything else before it is sent. The OAuth role is the second layer.
- **Customer data is masked by default.** Phone numbers keep the last four digits (`+1•••4567`), emails keep the first letter and domain, customer names become initials. Agent names are shown. Set `GENESYS_REDACT=false` only if the assistant is allowed to see full customer data.
- **Credentials stay in the environment.** They are not logged or returned in tool results.
- **Rate limits.** 429 and 5xx responses are retried with `Retry-After` or exponential backoff, up to three times.

## Library

The server can be embedded, for example to run it over a different transport or to point it at another implementation of the API:

```ts
import { createServer, HttpPlatformClient } from 'genesys-cloud-mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const client = new HttpPlatformClient({ clientId, clientSecret, region: 'mypurecloud.com' });
const server = createServer({ client, timeZone: 'America/Bogota' });
await server.connect(new StdioServerTransport());
```

`PlatformClient` is a single `request(method, path, options)` method. `DemoPlatformClient` implements it with the simulated center, which is also what the tests use.

## Limits

- Directory lookups (queues, users, wrap-up codes) read up to 2,000 entries each and are cached for five minutes.
- `search_conversations` returns at most 100 conversations per call and uses the synchronous details query, which Genesys Cloud limits to recent intervals. Large exports belong in an analytics job, not in a chat.
- Service level is reported as computed by Genesys Cloud for each queue; the 20 second target shown in results is the demo's setting.
- Queue observations are per queue. An agent who is a member of several queues is counted in each.

## Development

```sh
npm install
npm test
npm run try -- get_queue_status '{"queues":["Support"]}'
```

Design notes are in [docs/adr](docs/adr).

## License

MIT
