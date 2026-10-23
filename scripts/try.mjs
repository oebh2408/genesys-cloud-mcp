// Calls a few tools against the demo contact center and prints the results.
// Usage: npm run try [-- tool '{"arg":"value"}']
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, DemoPlatformClient } from '../dist/index.js';

const server = createServer({ client: new DemoPlatformClient(), timeZone: 'America/Bogota', demo: true });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'try', version: '1.0.0' });
await client.connect(b);

const [tool, args] = process.argv.slice(2);
const calls = tool
  ? [[tool, JSON.parse(args ?? '{}')]]
  : [
      ['get_queue_status', { queues: ['Support', 'Chat Support'] }],
      ['get_queue_performance', { interval: 'yesterday' }],
      ['search_conversations', { interval: 'yesterday', outcome: 'abandoned', limit: 3 }],
    ];

for (const [name, input] of calls) {
  const res = await client.callTool({ name, arguments: input });
  console.log(`\n> ${name} ${JSON.stringify(input)}\n`);
  console.log(res.content[0].text);
}
await client.close();
