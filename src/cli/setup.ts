import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  ConfigSchema,
  configPath,
  isValidTimeZone,
  loadConfig,
  saveConfig,
  type Config,
  type Region,
} from '../config.js';
import { TokenProvider } from '../halaxy/auth.js';
import { HalaxyClient } from '../halaxy/client.js';
import { baseUrlFor } from '../halaxy/refs.js';
import { KeychainStore, writeCredentials } from '../secrets.js';
import { ask, askHidden } from './prompt.js';

export async function runSetup(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(
      'halaxy-mcp setup must be run by a person in an interactive terminal (it asks for the client secret).',
    );
    return 1;
  }
  console.error('halaxy-mcp setup\n');
  console.error(
    'Create an API key in Halaxy → Settings → Integrations → External → Create New Key,',
  );
  console.error('scoped to the least access needed (see README → "Halaxy API key").\n');

  let existing: Partial<Config> = {};
  try {
    existing = loadConfig();
  } catch {
    // first run
  }

  const clientId = await ask('Client ID');
  const clientSecret = await askHidden('Client secret (hidden)');
  if (!clientId || !clientSecret) {
    console.error('Client ID and secret are required.');
    return 1;
  }

  let region = (await ask('Region (au or eu)', existing.region ?? 'au')).toLowerCase();
  while (region !== 'au' && region !== 'eu')
    region = (await ask('Region must be "au" or "eu"', 'au')).toLowerCase();

  const defaultTz = existing.timezone ?? 'Australia/Sydney';
  let timezone = await ask('Practice timezone (IANA)', defaultTz);
  while (!isValidTimeZone(timezone))
    timezone = await ask('Not a valid IANA timezone, try e.g. Australia/Sydney', defaultTz);

  let attachmentsDir: string | undefined = await ask(
    'Attachments folder (referral PDFs are only read from here; blank to disable)',
    existing.attachmentsDir,
  );
  while (attachmentsDir) {
    const abs = isAbsolute(attachmentsDir) ? attachmentsDir : resolve(attachmentsDir);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      attachmentsDir = abs;
      break;
    }
    attachmentsDir = await ask(
      'That folder does not exist. Enter an existing folder (blank to disable)',
    );
  }

  console.error('\nChecking the credentials with Halaxy…');
  const base = baseUrlFor(region as Region);
  const tokens = new TokenProvider(base, async () => ({ clientId, clientSecret }));
  try {
    await tokens.getToken();
    const client = new HalaxyClient(base, tokens);
    await client.get('Patient', { _count: 1 });
  } catch (err) {
    console.error(`Validation failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    console.error('Nothing was saved.');
    return 1;
  }

  await writeCredentials(new KeychainStore(), { clientId, clientSecret });
  const config = ConfigSchema.parse({
    ...existing,
    region,
    timezone,
    ...(attachmentsDir ? { attachmentsDir } : { attachmentsDir: undefined }),
  });
  saveConfig(config);
  console.error(`\n✓ Credentials stored in the OS keychain (service "halaxy-mcp").`);
  console.error(`✓ Config written to ${configPath()}`);
  console.error(
    'Next: run "halaxy-mcp doctor", then register the server with your MCP client (see README).',
  );
  return 0;
}
