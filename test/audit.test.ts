import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/safety/audit.js';
import { tempDir } from './helpers.js';

describe('audit log', () => {
  it('appends one JSON line per commit with only the allowed fields', () => {
    const dir = tempDir();
    const log = new AuditLog(dir, true, '1.0.0');
    const id = log.record('halaxy_prepare_create_patient', 'Patient', '123', 'success');
    log.record('halaxy_prepare_create_patient', 'Patient', undefined, 'failure');
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      auditId: id,
      tool: 'halaxy_prepare_create_patient',
      resourceType: 'Patient',
      resourceId: '123',
      outcome: 'success',
      serverVersion: '1.0.0',
    });
    expect(lines[1].resourceId).toBeNull();
  });

  it('rotates at the size limit and keeps 5 files', () => {
    const dir = tempDir();
    const log = new AuditLog(dir, true, '1.0.0', 400);
    for (let i = 0; i < 40; i++) log.record('t', 'Patient', String(i), 'success');
    const files = [
      'audit.jsonl',
      'audit.jsonl.1',
      'audit.jsonl.2',
      'audit.jsonl.3',
      'audit.jsonl.4',
    ];
    for (const f of files) expect(existsSync(join(dir, f))).toBe(true);
    expect(existsSync(join(dir, 'audit.jsonl.5'))).toBe(false);
    for (const f of files) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(400);
  });

  it('writes nothing when disabled but still returns an id', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'marker'), '');
    const id = new AuditLog(dir, false, '1.0.0').record('t', 'Patient', '1', 'success');
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });
});
