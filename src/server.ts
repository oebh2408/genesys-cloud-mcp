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
        'Read-only access to a Genesys Cloud contact center: queues, agents, conversations and analytics.',
        `Relative intervals such as "today" use the ${ctx.timeZone} time zone.`,
        'Times in results are ISO-8601 UTC. Durations are in seconds. Service level uses a 20 second target.',
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

  return server;
}
