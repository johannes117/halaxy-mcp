#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { log } from './logger.js';
import { KeychainStore, deleteCredentials } from './secrets.js';
import { createContext, createServer } from './server.js';
import { serverVersion } from './version.js';

const USAGE = `halaxy-mcp ${serverVersion()}

Usage:
  halaxy-mcp            Start the MCP server on stdio
  halaxy-mcp setup      Store API credentials in the OS keychain and write config (run by a human)
  halaxy-mcp doctor     Check the installation
  halaxy-mcp version    Print the installed version
  halaxy-mcp forget     Remove the stored credentials from the keychain
`;

async function startServer(): Promise<void> {
  const config = loadConfig();
  const server = createServer(createContext(config));
  await server.connect(new StdioServerTransport());
  log.info(
    `server ${serverVersion()} running on stdio (writes ${config.writesEnabled ? 'enabled' : 'disabled'})`,
  );
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case undefined:
      await startServer();
      return -1;
    case 'setup':
      return (await import('./cli/setup.js')).runSetup();
    case 'doctor':
      return (await import('./cli/doctor.js')).runDoctor();
    case 'version':
    case '--version':
    case '-v':
      console.log(serverVersion());
      return 0;
    case 'forget':
      await deleteCredentials(new KeychainStore());
      console.error('Removed halaxy-mcp credentials from the keychain.');
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    log.error(err instanceof Error ? err.message : 'fatal error');
    process.exitCode = 1;
  },
);
