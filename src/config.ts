import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

export const REGIONS = ['au', 'eu'] as const;
export type Region = (typeof REGIONS)[number];

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ConfigSchema = z
  .object({
    region: z.enum(REGIONS).default('au'),
    timezone: z
      .string()
      .refine(isValidTimeZone, {
        message: 'timezone must be a valid IANA zone, e.g. Australia/Sydney',
      })
      .default('Australia/Sydney'),
    attachmentsDir: z
      .string()
      .refine((p) => isAbsolute(p), { message: 'attachmentsDir must be an absolute path' })
      .optional(),
    writesEnabled: z.boolean().default(true),
    auditLog: z.boolean().default(true),
    /**
     * The Medicare Coverage payload shape could not be confirmed against Halaxy's docs, so the
     * coverage tool is only registered when this is explicitly turned on (see README).
     */
    enableMedicareCoverage: z.boolean().default(false),
    /**
     * Optional override for the Halaxy appointment-participant-status codes used by
     * halaxy_prepare_cancel_appointment. Defaults: noCharge = "cancelled (no charge)";
     * late is looked up from Halaxy's CodeSystem when not set.
     */
    cancellationCodes: z
      .object({ noCharge: z.string().min(1).optional(), late: z.string().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function configDir(): string {
  if (process.env.HALAXY_MCP_CONFIG_DIR) return process.env.HALAXY_MCP_CONFIG_DIR;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'halaxy-mcp');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'halaxy-mcp');
}

export function stateDir(): string {
  if (process.env.HALAXY_MCP_STATE_DIR) return process.env.HALAXY_MCP_STATE_DIR;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'halaxy-mcp');
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'halaxy-mcp');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid config.json: ${details}`);
  }
  return result.data;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`No config found at ${path}. Run "halaxy-mcp setup" first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(`Could not parse ${path} as JSON.`);
  }
  const config = parseConfig(raw);
  if (config.attachmentsDir) {
    try {
      if (!statSync(config.attachmentsDir).isDirectory()) {
        throw new ConfigError(`attachmentsDir is not a directory: ${config.attachmentsDir}`);
      }
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw new ConfigError(`attachmentsDir does not exist: ${config.attachmentsDir}`);
    }
  }
  return config;
}

export function saveConfig(config: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
