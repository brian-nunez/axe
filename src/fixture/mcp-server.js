#!/usr/bin/env node
/**
 * The MCP server — which is the fixture.
 *
 * The Python graph is its client. It launches the browser, logs the extension
 * in, holds the panel through its lifecycle, scans, saves the test and starts
 * the keepalive, and only then answers `tools/list`. That ordering is the whole
 * point: CONTEXT's contract is that the agent's job starts at *read the panel*,
 * and the agent handles no credentials and manages no browser lifecycle.
 *
 * To say it once, plainly: this is not Deque's axe MCP Server, which is outside
 * our licence. This is our own code, driving our own licensed extension, over a
 * protocol that happens to share a name.
 *
 * Every log line goes to stderr. stdout is the transport.
 *
 *   node fixture/mcp-server.js --extension=build/axe-extension --url=http://127.0.0.1:8731/
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { Fixture, describeFixture } from './fixture.js';
import { buildTools } from './tools.js';

const DEFAULT_URL = 'http://127.0.0.1:8731/';

function parseArgs(argv) {
  const args = { headless: true, url: DEFAULT_URL, name: null, extensionPath: null, profile: null };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--url=')) args.url = arg.slice(6);
    else if (arg.startsWith('--name=')) args.name = arg.slice(7);
    else if (arg.startsWith('--profile=')) args.profile = arg.slice(10);
    else if (arg === '--headed') args.headless = false;
    else throw new Error(`unrecognised argument: ${arg}`);
  }
  if (!args.extensionPath) throw new Error('--extension=<unpacked directory> is required');
  return args;
}

const log = (message) => process.stderr.write(`[fixture] ${message}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testName = args.name ?? `axedevtools v0 — ${new Date().toISOString()}`;

  const fixture = await Fixture.start({
    extensionPath: args.extensionPath,
    url: args.url,
    testName,
    headless: args.headless,
    userDataDir: args.profile,
    log,
  });

  const tools = buildTools(fixture);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  log(`serving ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

  const server = new Server(
    { name: 'axedevtools-fixture', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      // The fixture handle every deterministic tier needs, delivered as
      // instructions rather than as a tool call: the graph's `enter_fixture`
      // node holds it for the life of the run and nothing else may change it.
      instructions: JSON.stringify({ fixture: describeFixture(fixture) }),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        content: [
          {
            type: 'text',
            // Retryable, per 011 F1: a name that resolves to nothing is a
            // different call away from working, and the served set is what the
            // caller should look at.
            text: JSON.stringify({
              ok: false,
              error: 'not_found',
              detail: `no tool named ${request.params.name}; this server serves ` +
                `${[...byName.keys()].join(', ')}`,
              retryable: true,
            }),
          },
        ],
      };
    }

    // No tool raises for a dead panel, and a bug in one must not look like a
    // transport failure to the graph — it is a unit that errored, which the
    // graph already has a disposition for.
    //
    // Retryable, because the commonest way to reach here is a Playwright
    // timeout on a panel that was mid-relayout, and the same call a moment later
    // succeeds. A caller that cannot get past it still has `check_ledger`.
    let result;
    try {
      result = await tool.handler(request.params.arguments);
    } catch (error) {
      log(`${tool.name} threw: ${error.stack ?? error.message}`);
      result = {
        ok: false,
        error: 'rejected',
        detail: `${tool.name} raised: ${error.message}`,
        retryable: true,
      };
    }

    const { images = [], ...envelope } = result;
    return {
      content: [
        { type: 'text', text: JSON.stringify(envelope) },
        ...images.map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType })),
      ],
    };
  });

  const shutdown = async () => {
    log('shutting down');
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  log('ready');
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
