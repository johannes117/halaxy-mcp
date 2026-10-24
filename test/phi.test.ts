import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLogSink } from '../src/logger.js';
import { errorResult } from '../src/server.js';
import { commitTool } from '../src/tools/commit.js';
import { prepareCreateMedicareCoverageTool } from '../src/tools/coverage.js';
import { prepareCreatePatientTool, searchPatientsTool } from '../src/tools/patients.js';
import { BASE, TEST_MEDICARE, TEST_SECRET, TEST_TOKEN, bundle, makeCtx, run } from './helpers.js';

// Distinctive synthetic values so any leak is easy to spot.
const GIVEN = 'Zephyrina';
const FAMILY = 'Quorvathsynth';
const DOB = '1999-12-31';
const MOBILE = '+61400000987';
const EMAIL = 'zephyrina.synthetic@example.com';
const FORBIDDEN = [
  GIVEN,
  FAMILY,
  DOB,
  MOBILE,
  '0400000987',
  EMAIL,
  TEST_MEDICARE,
  TEST_TOKEN,
  TEST_SECRET,
];

describe('no PHI or secrets in logs, audit or errors', () => {
  const captured: string[] = [];
  beforeEach(() => {
    process.env.HALAXY_MCP_DEBUG = '1';
    setLogSink((line) => captured.push(line));
  });
  afterEach(() => {
    delete process.env.HALAXY_MCP_DEBUG;
    setLogSink(undefined);
  });

  it('holds across successful and failing flows', async () => {
    const patientRes = {
      resourceType: 'Patient',
      id: '5001',
      name: [{ given: ['Other'], family: FAMILY }],
      birthDate: DOB,
      telecom: [{ system: 'sms', value: MOBILE }],
    };
    let postCount = 0;
    const { ctx, auditDir } = makeCtx([
      { method: 'GET', path: 'Patient', reply: { body: bundle([patientRes]) } },
      { method: 'GET', path: 'Patient/5001', reply: { body: patientRes } },
      { method: 'GET', path: 'Coverage', reply: { body: bundle([]) } },
      {
        method: 'POST',
        path: 'Patient',
        reply: () =>
          ++postCount === 1
            ? {
                status: 422,
                body: {
                  resourceType: 'OperationOutcome',
                  issue: [{ diagnostics: 'telecom invalid' }],
                },
              }
            : { status: 201, body: { resourceType: 'Patient', id: '5002' } },
      },
      {
        method: 'POST',
        path: 'Coverage',
        reply: { status: 201, body: { resourceType: 'Coverage', id: 'C9' } },
      },
    ]);

    const outputs: string[] = [];
    const args = {
      given: GIVEN,
      family: FAMILY,
      birthDate: DOB,
      mobile: MOBILE,
      email: EMAIL,
      source: 'direct',
    };

    // Search output masks mobile.
    outputs.push(
      JSON.stringify(await run(searchPatientsTool, { family: FAMILY }, ctx))
        .replaceAll(FAMILY, '')
        .replaceAll(DOB, ''),
    );

    // Failed commit (422), then a successful one.
    const p1 = await run(prepareCreatePatientTool, args, ctx);
    const failed = await run(commitTool, { confirmationId: p1.confirmationId }, ctx).catch(
      (e: unknown) => errorResult(e),
    );
    outputs.push(JSON.stringify(failed));
    const p2 = await run(prepareCreatePatientTool, args, ctx);
    await run(commitTool, { confirmationId: p2.confirmationId }, ctx);

    // Medicare preview never shows the full number.
    const cov = await run(
      prepareCreateMedicareCoverageTool,
      { patientId: '5001', medicareNumber: TEST_MEDICARE, irn: 1 },
      ctx,
    );
    outputs.push(JSON.stringify(cov));
    await run(commitTool, { confirmationId: cov.confirmationId }, ctx);

    // Unexpected internal errors are generic.
    outputs.push(JSON.stringify(errorResult(new Error(`boom ${GIVEN} ${TEST_TOKEN}`))));

    const audit = readdirSync(auditDir)
      .map((f) => readFileSync(join(auditDir, f), 'utf8'))
      .join('\n');
    expect(audit.split('\n').filter(Boolean)).toHaveLength(3);
    expect(captured.length).toBeGreaterThan(0); // debug logging was exercised

    const haystacks = {
      logs: captured.join('\n'),
      audit,
      errors: outputs.slice(1, 2).join('\n'),
      outputs: outputs.join('\n'),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const needle of where === 'outputs'
        ? [TEST_MEDICARE, TEST_TOKEN, TEST_SECRET, MOBILE]
        : FORBIDDEN) {
        expect(text, `${where} leaked ${needle}`).not.toContain(needle);
      }
    }
    expect(haystacks.logs).not.toContain(BASE + 'Patient?');
  });
});
