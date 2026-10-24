import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { configPath, loadConfig, stateDir, type Config } from '../config.js';
import { TokenProvider } from '../halaxy/auth.js';
import { HalaxyClient } from '../halaxy/client.js';
import { baseUrlFor } from '../halaxy/refs.js';
import { KeychainStore, readCredentials, type Credentials } from '../secrets.js';
import { serverVersion } from '../version.js';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

/** Runs environment checks. Never prints secrets or patient data. */
export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) =>
    checks.push({ name, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js version', major >= 20 ? 'PASS' : 'FAIL', `v${process.versions.node} (need ≥ 20)`);

  let config: Config | undefined;
  try {
    config = loadConfig();
    add(
      'Config',
      'PASS',
      `${configPath()} (region ${config.region}, timezone ${config.timezone}, writes ${config.writesEnabled ? 'enabled' : 'disabled'})`,
    );
  } catch (err) {
    add('Config', 'FAIL', err instanceof Error ? err.message : 'invalid');
  }

  let creds: Credentials | undefined;
  try {
    creds = await readCredentials(new KeychainStore());
    add('Keychain', 'PASS', 'client_id and client_secret present');
  } catch (err) {
    add('Keychain', 'FAIL', err instanceof Error ? err.message : 'not accessible');
  }

  if (config && creds) {
    const base = baseUrlFor(config.region);
    const c = creds;
    const tokens = new TokenProvider(base, async () => c);
    try {
      await tokens.getToken();
      add('Token', 'PASS', `obtained from ${new URL(base).host}`);
      const client = new HalaxyClient(base, tokens);
      try {
        const meta = await client.get<{ rest?: Array<{ resource?: Array<{ type?: string }> }> }>(
          'metadata',
        );
        const count = meta?.rest?.[0]?.resource?.length ?? 0;
        add('Capabilities', 'PASS', `${count} resource types advertised`);
      } catch (err) {
        add('Capabilities', 'FAIL', err instanceof Error ? err.message : 'failed');
      }
      try {
        await client.get('Patient', { _count: 1 });
        add('Patient read', 'PASS', 'key can read patients');
      } catch (err) {
        add('Patient read', 'FAIL', err instanceof Error ? err.message : 'failed');
      }
    } catch (err) {
      add('Token', 'FAIL', err instanceof Error ? err.message : 'failed');
    }
  } else {
    add('Token', 'FAIL', 'skipped (config or keychain check failed)');
  }

  if (config?.attachmentsDir) {
    try {
      await access(config.attachmentsDir, constants.R_OK);
      add('Attachments folder', 'PASS', `${config.attachmentsDir} is readable`);
    } catch {
      add('Attachments folder', 'FAIL', `${config.attachmentsDir} is not readable`);
    }
  } else if (config) {
    add('Attachments folder', 'WARN', 'not configured; referral attachments are disabled');
  }

  if (config?.auditLog) {
    try {
      await mkdir(stateDir(), { recursive: true, mode: 0o700 });
      await access(stateDir(), constants.W_OK);
      add('Audit log', 'PASS', `${stateDir()} is writable`);
    } catch {
      add('Audit log', 'FAIL', `${stateDir()} is not writable`);
    }
  }
  if (config && config.writesEnabled && !config.enableMedicareCoverage) {
    add('Medicare coverage tool', 'WARN', 'disabled (enableMedicareCoverage is false; see README)');
  }

  console.log(`halaxy-mcp ${serverVersion()} doctor`);
  for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}
