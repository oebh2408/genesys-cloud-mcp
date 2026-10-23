# Changelog

## 0.1.0

- Fifteen read-only tools. Queues: `list_queues`, `get_queue`, `get_queue_status`, `get_queue_performance`, `compare_queue_performance`. Agents: `list_agents`, `get_agent`, `get_agent_performance`, `get_agent_status_summary`, `get_agent_timeline`. Conversations: `search_conversations`, `get_conversation`, `get_wrapup_summary`. Flows and hours: `get_flow_performance`, `get_schedule_status`.
- Prompts: `queue_health_report`, `daily_summary`, `agent_review`, `abandon_investigation`.
- Schedule evaluation for Architect schedule groups (holiday, closed and open schedules, common RRULEs).
- OAuth client credentials with token caching, retries on 429 and 5xx, and a read-only request guard.
- Masking of customer phone numbers, emails and names, on by default.
- Demo contact center with simulated routing, IVR and chat bot flows, opening hours and holidays, agent breaks and lunch, five weeks of history and live status.
