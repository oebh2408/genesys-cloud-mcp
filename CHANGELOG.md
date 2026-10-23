# Changelog

## 0.1.0

- Seven read-only tools: `list_queues`, `get_queue_status`, `get_queue_performance`, `list_agents`, `get_agent_performance`, `search_conversations`, `get_conversation`.
- `queue_health_report` prompt.
- OAuth client credentials with token caching, retries on 429 and 5xx, and a read-only request guard.
- Masking of customer phone numbers, emails and names, on by default.
- Demo contact center with simulated routing, five weeks of history and live status.
