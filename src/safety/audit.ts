import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../logger.js';

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
/** Total files kept, including the live one. */
export const AUDIT_KEEP = 5;

export interface AuditEntry {
  ts: string;
  auditId: string;
  tool: string;
  resourceType: string;
  resourceId: string | null;
  outcome: 'success' | 'failure';
  serverVersion: string;
}

/**
 * Append-only audit log of committed writes. Entries hold ids and outcomes only:
 * never names, DOBs, Medicare numbers, contact details or free text.
 */
export class AuditLog {
  constructor(
    private readonly dir: string,
    private readonly enabled: boolean,
    private readonly version: string,
    private readonly maxBytes = AUDIT_MAX_BYTES,
  ) {}

  get path(): string {
    return join(this.dir, AUDIT_FILE);
  }

  record(
    tool: string,
    resourceType: string,
    resourceId: string | undefined,
    outcome: AuditEntry['outcome'],
  ): string {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      auditId: randomUUID(),
      tool,
      resourceType,
      resourceId: resourceId ?? null,
      outcome,
      serverVersion: this.version,
    };
    if (!this.enabled) return entry.auditId;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry) + '\n';
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      log.warn('could not write audit log entry');
    }
    return entry.auditId;
  }

  private rotateIfNeeded(incoming: number): void {
    if (!existsSync(this.path)) return;
    if (statSync(this.path).size + incoming <= this.maxBytes) return;
    const oldest = `${this.path}.${AUDIT_KEEP - 1}`;
    if (existsSync(oldest)) rmSync(oldest);
    for (let i = AUDIT_KEEP - 2; i >= 1; i--) {
      const from = `${this.path}.${i}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
  }
}
