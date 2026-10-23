# Changelog

## 0.1.0

- 31 read-only tools. Queues: `list_queues`, `get_queue`, `get_queue_status`, `get_queue_performance`, `compare_queue_performance`. Agents: `list_agents`, `get_agent`, `get_agent_performance`, `get_agent_status_summary`, `get_agent_timeline`. Conversations: `search_conversations`, `get_conversation`, `get_wrapup_summary`. Flows and hours: `get_flow_performance`, `get_schedule_status`. Quality and surveys: `get_quality_summary`, `list_evaluations`, `get_survey_summary`, `list_survey_responses`. Workforce management: `get_adherence`, `get_agent_schedule`, `get_staffing`. Callbacks and outbound: `get_callbacks`, `get_campaigns`. Channels and bots: `get_channel_mix`, `get_bot_performance`. Routing setup: `find_agents`, `get_routing_overview`. Teams: `list_teams`, `get_team_performance`. Change history: `get_recent_changes`.
- Prompts: `queue_health_report`, `daily_summary`, `agent_review`, `abandon_investigation`, `change_review`.
- Schedule evaluation for Architect schedule groups (holiday, closed and open schedules, common RRULEs).
- OAuth client credentials with token caching, retries on 429 and 5xx, and a read-only request guard.
- Masking of customer phone numbers, emails and names, also inside survey comments and bot messages, on by default.
- Demo contact center with simulated routing, IVR and messaging bot flows, web messaging, WhatsApp and Facebook, teams and divisions, an audit log, callbacks, opening hours and holidays, published shifts and how agents follow them, quality evaluations, surveys, outbound campaigns, five weeks of history and live status.
