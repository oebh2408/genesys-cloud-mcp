#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DemoPlatformClient } from './client/demo.js';
import { HttpPlatformClient } from './client/http.js';
import { createServer } from './server.js';
import { assertTimeZone } from './time.js';

function config() {
  const env = process.env;
  const demo = process.argv.includes('--demo') || /^(1|true|yes)$/i.test(env.GENESYS_DEMO ?? '');
  const timeZone = env.GENESYS_TIMEZONE ?? 'UTC';
  assertTimeZone(timeZone);
  const redact = !/^(0|false|no)$/i.test(env.GENESYS_REDACT ?? 'true');

  if (demo) return { client: new DemoPlatformClient(), timeZone: env.GENESYS_TIMEZONE ?? 'America/Bogota', redact, demo };

  const missing = ['GENESYS_CLIENT_ID', 'GENESYS_CLIENT_SECRET', 'GENESYS_REGION'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Set them to use a real org, or start with --demo to use the built-in demo contact center.`);
  }
  const region = env.GENESYS_REGION!.replace(/^https?:\/\//, '').replace(/^(api|login|apps)\./, '');
  return {
    client: new HttpPlatformClient({ clientId: env.GENESYS_CLIENT_ID!, clientSecret: env.GENESYS_CLIENT_SECRET!, region }),
    timeZone,
    redact,
    demo,
  };
}

try {
  const server = createServer(config());
  await server.connect(new StdioServerTransport());
} catch (err) {
  process.stderr.write(`genesys-cloud-mcp: ${(err as Error).message}\n`);
  process.exit(1);
}
