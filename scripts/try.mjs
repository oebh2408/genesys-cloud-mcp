// Calls a few tools against the demo contact center and prints the results as tables.
// Usage: npm run try                          four sample calls
//        npm run try -- tool '{"arg":"value"}'  one call, raw JSON as the model receives it
// DEMO_NOW pins the clock (an ISO date), so the output can be reproduced.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, DemoPlatformClient } from '../dist/index.js';

const now = process.env.DEMO_NOW ? () => new Date(process.env.DEMO_NOW) : () => new Date();
const timeZone = 'America/Bogota';
const server = createServer({ client: new DemoPlatformClient(now), timeZone, demo: true, now });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'try', version: '1.0.0' });
await client.connect(b);

const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const [tool, args] = process.argv.slice(2);
if (tool) {
  console.log(JSON.stringify(await call(tool, JSON.parse(args ?? '{}')), null, 2));
  await client.close();
  process.exit(0);
}

/** Right-aligns the columns that hold numbers, durations or percentages. */
function table(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map(String));
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  const numeric = headers.map((_, i) => rows.every((r) => /^[\d.]+(%|s|m \d+s|h \d+m)?$/.test(String(r[i]))));
  return cells.map((r) => '  ' + r.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('   ').trimEnd()).join('\n');
}
const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`);
const time = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' });
const show = (name, input) => console.log(`\n→ ${name} ${JSON.stringify(input)}\n`);

let input = {};
show('get_queue_status', input);
const status = await call('get_queue_status', input);
console.log(table(
  ['queue', 'waiting', 'longest wait', 'interacting', 'on queue', 'idle'],
  status.queues.map((q) => [q.queue, q.waiting, secs(q.longestWaitSeconds), q.interacting, q.agentsOnQueue, q.agentsIdle]),
));

input = { interval: 'today' };
show('get_queue_performance', input);
const perf = await call('get_queue_performance', input);
console.log(table(
  ['queue', 'offered', 'abandoned', 'service level', 'avg answer', 'avg handle'],
  perf.queues.map((q) => [q.queue, q.offered, `${q.abandonRatePercent}%`, `${q.serviceLevelPercent}%`, secs(q.avgSpeedOfAnswerSeconds), secs(q.avgHandleSeconds)]),
));

input = { interval: 'today', queue: 'Billing', outcome: 'abandoned', limit: 4 };
show('search_conversations', input);
const found = await call('search_conversations', input);
console.log(table(
  ['started', 'queue', 'media', 'waited', 'customer', 'from'],
  found.conversations.map((c) => [time(c.start), c.queue, c.mediaType, secs(c.waitSeconds), c.customer, c.from]),
));
console.log(`\n  ${found.returned} of ${found.totalHits}. Customer names, numbers and addresses are masked by default.`);

input = { queue: 'Billing', interval: 'today' };
show('get_agent_status_summary', input);
const team = await call('get_agent_status_summary', input);
const mins = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
console.log(table(
  ['agent', 'logged in', 'on queue', 'interacting', 'off queue', 'occupancy'],
  team.agents.map((a) => [a.agent, mins(a.loggedInMinutes), mins(a.onQueueMinutes), mins(a.interactingMinutes), mins(a.offQueueMinutes), `${a.occupancyPercent}%`]),
));

await client.close();
