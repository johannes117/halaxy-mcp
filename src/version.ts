import { readFileSync } from 'node:fs';

let cached: string | undefined;

/** The installed package version, read from package.json (one level above src/ and dist/). */
export function serverVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export function userAgent(): string {
  return `halaxy-mcp/${serverVersion()}`;
}
