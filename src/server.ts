import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PlatformClient } from './client/types.js';
import { Directory } from './directory.js';
import { tools, type ToolContext } from './tools.js';

export interface ServerOptions {
  client: PlatformClient;
  /** IANA time zone used for today, yesterday and this_week. Default UTC. */
  timeZone?: string;
  /** Mask customer phone numbers, emails and names. Default true. */
  redact?: boolean;
  now?: () => Date;
  /** Shown to the client as part of the server instructions. */
  demo?: boolean;
}

export const SERVER_NAME = 'genesys-cloud-mcp';
export const SERVER_VERSION = '0.1.0';

export function createServer(options: ServerOptions): McpServer {
  const now = options.now ?? (() => new Date());
  const ctx: ToolContext = {
    client: options.client,
    directory: new Directory(options.client, now),
    now,
    timeZone: options.timeZone ?? 'UTC',
    redact: options.redact ?? true,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Read-only access to a Genesys Cloud contact center: queues, agents, conversations, channels, IVR and bot flows, opening hours, quality evaluations, surveys, workforce management schedules, outbound campaigns, teams, routing setup and the audit log of configuration changes.',
        `Relative intervals such as "today" use the ${ctx.timeZone} time zone.`,
        'Times in results are ISO-8601 UTC. Durations are in seconds unless the field name says minutes. Service level uses a 20 second target.',
        ctx.redact ? 'Customer phone numbers, emails and names are masked.' : '',
        options.demo ? 'This server is connected to a fictional demo contact center, not a real org.' : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(args as never, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: (err as Error).message }] };
        }
      },
    );
  }

  server.registerPrompt(
    'queue_health_report',
    {
      title: 'Queue health report',
      description: 'Summarize how the queues are doing right now and so far today, and point out where to act.',
      argsSchema: { queue: z.string().optional().describe('Limit the report to one queue') },
    },
    ({ queue }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Write a short health report for ${queue ? `the ${queue} queue` : 'all queues'}.`,
              'Use get_queue_status for the live picture and get_queue_performance with interval "today" and granularity PT1H for the trend.',
              'Lead with the queues that miss the 80% service level or have an abandon rate above 5%, and say in which hours it happened.',
              'If a queue has calls waiting and idle agents are available elsewhere, say so. Keep it under 200 words and use plain numbers.',
            ].join(' '),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'daily_summary',
    {
      title: 'Daily summary',
      description: 'A summary of one day for the operations team: volumes, service level, abandons, the IVR, and how calls were closed, compared with the same day a week earlier.',
      argsSchema: { day: z.string().optional().describe('yesterday (default), today, or an ISO-8601 interval') },
    },
    ({ day }) => prompt(
      `Write a summary of ${day ?? 'yesterday'} for the operations team.`,
      `Use compare_queue_performance with interval "${day ?? 'yesterday'}" for volumes, service level and abandons against the same day a week earlier, get_channel_mix for the split by channel, get_flow_performance for the IVR, get_bot_performance for the messaging bot, get_wrapup_summary for how interactions were closed, get_callbacks for callbacks, and get_survey_summary for NPS.`,
      'Start with three lines: total offered, overall service level and abandon rate, each with the change. Then one line per queue that missed 80% service level or 5% abandon rate, one line on the channels, and one line on the IVR and the bot (share that ended in the flow, share sent to an agent).',
      'Finish with NPS and the response rate, and the two wrap-up codes that changed the most if they are notable. Plain numbers, no more than 250 words.',
    ),
  );

  server.registerPrompt(
    'agent_review',
    {
      title: 'Agent review',
      description: 'Prepare a one-to-one with an agent: volume, handle time against the team, time on queue and adherence, quality scores, survey results and wrap-up codes.',
      argsSchema: { agent: z.string().describe('Agent name'), interval: z.string().optional().describe('this_week (default), last 7d, last 30d...') },
    },
    ({ agent, interval }) => prompt(
      `Prepare notes for a one-to-one with ${agent} covering ${interval ?? 'this_week'}.`,
      `Use get_agent for queues and skills, get_agent_performance for ${agent} and for the same queues without an agent filter to have the team average, get_agent_status_summary for time on queue and occupancy, get_quality_summary and list_evaluations for quality scores and critical failures, get_survey_summary and list_survey_responses with the agent for what customers said, and get_wrapup_summary with the agent for how they close interactions.`,
      'Compare handle, hold and after-call work with the team average and say where the agent is more than 20% above or below. Mention time off queue by type if it is above 15% of the logged-in time. Quote at most two customer comments.',
      'Write it as facts to discuss, not as a judgement, in under 200 words.',
    ),
  );

  server.registerPrompt(
    'abandon_investigation',
    {
      title: 'Abandon investigation',
      description: 'Find out why a queue lost calls: when the abandons happened, how long callers waited, staffing at that time and what the IVR did.',
      argsSchema: { queue: z.string().describe('Queue name'), interval: z.string().optional().describe('today (default), yesterday, last 4h...') },
    },
    ({ queue, interval }) => prompt(
      `Investigate the abandoned interactions in ${queue} for ${interval ?? 'today'}.`,
      `Use get_queue_performance with granularity PT30M to find the half hours with the most abandons, search_conversations with outcome "abandoned" to see how long callers waited before hanging up, get_staffing to compare scheduled and actual agents in those half hours, get_callbacks to see whether callers took a callback instead, and get_flow_performance for the entry flow.`,
      'Check get_recent_changes for the queue and its entry flow over the last 7 days, and get_schedule_status if the abandons are near opening or closing time. Say whether the cause looks like volume, a schedule with too few agents, agents not following the schedule, long handle times, or callers giving up early, and back it with the numbers.',
      'Keep it under 250 words.',
    ),
  );

  server.registerPrompt(
    'change_review',
    {
      title: 'Change review',
      description: 'List the configuration changes of the last days and check whether the queues they touched behaved differently afterwards.',
      argsSchema: { interval: z.string().optional().describe('last 7d (default), last 24h, yesterday...') },
    },
    ({ interval }) => prompt(
      `Review the configuration changes of ${interval ?? 'the last 7 days'}.`,
      `Use get_recent_changes with interval "${interval ?? 'last 7d'}". Group the changes by object and say who made them and when, in local time.`,
      'For each queue or flow that changed, compare the day before and the day after the change with get_queue_performance or get_flow_performance, and say whether service level, abandons, handle time or the share that ended in the flow moved by more than a few points.',
      'Do not claim a change caused a difference; say what moved and when. Keep it under 250 words.',
    ),
  );

  return server;
}

function prompt(...lines: string[]) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join(' ') } }] };
}
