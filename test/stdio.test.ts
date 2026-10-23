import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;

// Runs the built server the way an MCP client does. Needs `npm run build` first.
describe.skipIf(!existsSync(cli))('stdio', () => {
  it('starts in demo mode and answers a tool call', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--demo'], stderr: 'pipe' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const res = (await client.callTool({ name: 'list_queues', arguments: {} })) as { content: { text: string }[] };
      expect(JSON.parse(res.content[0]!.text).count).toBe(6);
    } finally {
      await client.close();
    }
  });

  it('refuses to start without credentials outside demo mode', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Missing GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_REGION');
  });
});
