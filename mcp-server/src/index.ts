#!/usr/bin/env node
/**
 * Specular MCP server — stdio transport (Claude Desktop / local agent hosts).
 *
 * Same tools as the remote server (src/http.ts). Non-custodial by default:
 * write tools return unsigned transactions. The optional local signer
 * (`local_sign_and_broadcast`) is only registered when BOTH
 * SPECULAR_LOCAL_SIGNER=1 and SPECULAR_PRIVATE_KEY are set.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger, useStderr } from './logger.js';
import { createMcpServer, toolsFor } from './mcp.js';
import { enabledNetworks } from './networks.js';

useStderr(); // stdout is the JSON-RPC channel

if (process.env.SPECULAR_PRIVATE_KEY && process.env.SPECULAR_LOCAL_SIGNER !== '1') {
  logger.warn('SPECULAR_PRIVATE_KEY is set but SPECULAR_LOCAL_SIGNER is not "1"; the key is ignored and no signing tool is exposed');
}

const server = createMcpServer({ mode: 'local' });
const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() =>
    logger.info('specular mcp (stdio) ready', {
      tools: toolsFor('local').length,
      localSigner: process.env.SPECULAR_LOCAL_SIGNER === '1' && !!process.env.SPECULAR_PRIVATE_KEY,
      networks: enabledNetworks(),
    }),
  )
  .catch((e) => {
    logger.error('stdio transport failed', { error: (e as Error).message });
    process.exit(1);
  });
