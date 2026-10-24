import { describe, expect, it } from 'vitest';
import { Refs } from '../src/halaxy/refs.js';
import { PatientSchema } from '../src/halaxy/types.js';
import {
  buildBookParameters,
  buildCancelPatch,
  cancellationCode,
} from '../src/tools/appointments.js';
import { buildMedicareCoveragePayload } from '../src/tools/coverage.js';
import { buildPatientPatch, buildPatientPayload } from '../src/tools/patients.js';
import { buildReferralBody } from '../src/tools/referrals.js';
import { buildReferrerPlan, splitPersonName } from '../src/tools/referrers.js';
import { BASE, TEST_MEDICARE, makeCtx, patient, testConfig } from './helpers.js';

const refs = new Refs(BASE);

describe('golden payloads', () => {
  it('Patient create', () => {
    expect(
      buildPatientPayload({
        given: 'Test',
        family: 'Patient',
        birthDate: '2000-01-01',
        sex: 'female',
        mobile: '+61400000001',
        email: 'test.patient@example.com',
        address: { line: '1 Test St', suburb: 'Testville', state: 'NSW', postcode: '2000' },
        guardian: { name: 'Test Guardian', relationship: 'mother', mobile: '+61400000002' },
      }),
    ).toEqual({
      resourceType: 'Patient',
      name: [{ use: 'official', given: ['Test'], family: 'Patient' }],
      birthDate: '2000-01-01',
      gender: 'female',
      telecom: [
        { system: 'sms', value: '+61400000001', use: 'mobile' },
        { system: 'email', value: 'test.patient@example.com' },
      ],
      address: [
        {
          use: 'home',
          line: ['1 Test St'],
          city: 'Testville',
          state: 'NSW',
          postalCode: '2000',
          country: 'AU',
        },
      ],
      contact: [
        {
          relationship: [{ text: 'mother' }],
          name: { text: 'Test Guardian' },
          telecom: [{ system: 'sms', value: '+61400000002', use: 'mobile' }],
        },
      ],
    });
  });

  it('never sends identifier or active on Patient create', () => {
    const payload = buildPatientPayload({
      given: 'Test',
      family: 'Patient',
      birthDate: '2000-01-01',
    });
    expect(payload).not.toHaveProperty('identifier');
    expect(payload).not.toHaveProperty('active');
  });

  it('Patient merge-patch only touches changed fields and keeps other telecom entries', () => {
    const current = PatientSchema.parse(
      patient('1', {
        telecom: [
          { system: 'phone', value: '+61290000000', use: 'home' },
          { system: 'sms', value: '+61400000001', use: 'mobile' },
          { system: 'email', value: 'test.patient@example.com' },
        ],
      }),
    );
    const { patch, diff } = buildPatientPatch(current, {
      mobile: '+61400000009',
      email: 'test.patient@example.com',
      birthDate: '2000-01-01',
    });
    expect(patch).toEqual({
      telecom: [
        { system: 'phone', value: '+61290000000', use: 'home' },
        { system: 'sms', value: '+61400000009', use: 'mobile' },
        { system: 'email', value: 'test.patient@example.com' },
      ],
    });
    expect(diff).toEqual([{ field: 'mobile', before: '+61400000001', after: '+61400000009' }]);
  });

  it('Patient name patch keeps other names', () => {
    const current = PatientSchema.parse(
      patient('1', {
        name: [
          { use: 'official', given: ['Test'], family: 'Patient' },
          { use: 'nickname', given: ['Tess'] },
        ],
      }),
    );
    const { patch, diff } = buildPatientPatch(current, { family: 'Patientson' });
    expect(patch).toEqual({
      name: [
        { use: 'official', given: ['Test'], family: 'Patientson' },
        { use: 'nickname', given: ['Tess'] },
      ],
    });
    expect(diff).toEqual([{ field: 'name', before: 'Test Patient', after: 'Test Patientson' }]);
  });

  it('Medicare Coverage', () => {
    expect(buildMedicareCoveragePayload(refs, '1', TEST_MEDICARE, 2, '02/2028')).toEqual({
      resourceType: 'Coverage',
      status: 'active',
      type: { text: 'Medicare' },
      subscriberId: TEST_MEDICARE,
      dependent: '2',
      subscriber: { reference: `${BASE}Patient/1`, type: 'Patient' },
      beneficiary: { reference: `${BASE}Patient/1`, type: 'Patient' },
      payor: [{ display: 'Medicare' }],
      period: { end: '2028-02-29' },
    });
  });

  it('Referral uses full URL references and Halaxy property names', () => {
    const body = buildReferralBody(
      { refs, config: testConfig() },
      {
        patientId: '1',
        coverageId: 'C1',
        referrerRoleId: 'EP-9',
        referralDate: '2026-02-01',
        comment: 'MHCP – 6 sessions',
      },
    );
    expect(body).toEqual({
      resourceType: 'Referral',
      coverage: { reference: `${BASE}Coverage/C1`, type: 'Coverage' },
      subject: { reference: `${BASE}Patient/1`, type: 'Patient' },
      requester: { reference: `${BASE}PractitionerRole/EP-9`, type: 'PractitionerRole' },
      created: '2026-02-01T00:00:00+11:00',
      active: true,
      comment: 'MHCP – 6 sessions',
    });
  });

  it('Referrer plan', () => {
    expect(splitPersonName('Dr Test Referrer')).toEqual({
      prefix: 'Dr',
      given: ['Test'],
      family: 'Referrer',
    });
    expect(
      buildReferrerPlan({
        name: 'Dr Test Referrer',
        providerNumber: '2426591T',
        practiceName: 'Test Medical Centre',
        phone: '+61290000000',
        fax: '+61290000001',
      }),
    ).toEqual({
      practitioner: {
        resourceType: 'Practitioner',
        name: [{ use: 'official', prefix: ['Dr'], given: ['Test'], family: 'Referrer' }],
      },
      organization: { create: { resourceType: 'Organization', name: 'Test Medical Centre' } },
      role: {
        identifier: [
          {
            system: 'http://ns.electronichealth.net.au/id/medicare-provider-number',
            value: '2426591T',
          },
        ],
        telecom: [
          { system: 'phone', value: '+61290000000', use: 'work' },
          { system: 'fax', value: '+61290000001', use: 'work' },
        ],
      },
    });
  });

  it('$book Parameters', () => {
    expect(
      buildBookParameters(
        { refs },
        {
          patientId: '1',
          practitionerRoleId: 'PR-1',
          healthcareServiceId: 'HS1',
          start: '2026-03-02T10:00:00+11:00',
          end: '2026-03-02T10:50:00+11:00',
          durationMinutes: 50,
          locationType: 'clinic',
        },
      ),
    ).toEqual({
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'appt-resource',
          resource: {
            resourceType: 'Appointment',
            start: '2026-03-02T10:00:00+11:00',
            end: '2026-03-02T10:50:00+11:00',
            minutesDuration: 50,
            participant: [
              { actor: { reference: `${BASE}PractitionerRole/PR-1`, type: 'PractitionerRole' } },
            ],
          },
        },
        { name: 'patient-id', valueReference: { reference: `${BASE}Patient/1`, type: 'Patient' } },
        {
          name: 'healthcare-service-id',
          valueReference: { reference: `${BASE}HealthcareService/HS1`, type: 'HealthcareService' },
        },
        { name: 'location-type', valueCode: 'clinic' },
        { name: 'status', valueCode: 'booked' },
        { name: 'fail-on-double-booking', valueBoolean: true },
      ],
    });
  });

  it('cancel patch keeps all participants and sets the patient status extension', () => {
    const { ctx } = makeCtx([]);
    const practitioner = {
      actor: { reference: `${BASE}PractitionerRole/PR-1`, type: 'PractitionerRole' },
    };
    const patch = buildCancelPatch(
      ctx,
      {
        participant: [practitioner, { actor: { reference: `${BASE}Patient/1`, type: 'Patient' } }],
      },
      cancellationCode(ctx, 'no charge'),
    );
    expect(patch).toEqual({
      participant: [
        practitioner,
        {
          actor: { reference: `${BASE}Patient/1`, type: 'Patient' },
          modifierExtension: [
            {
              url: 'https://terminology.halaxy.com/StructureDefinition/appointment-participant-status',
              valueCoding: {
                system:
                  'https://au-api.halaxy.com/presets/CodeSystem/appointment-participant-status',
                code: 'cancelled (no charge)',
                display: 'cancelled (no charge)',
              },
            },
          ],
        },
      ],
    });
  });

  it('late cancellation requires a configured code', () => {
    const { ctx } = makeCtx([]);
    expect(() => cancellationCode(ctx, 'late cancellation')).toThrow(/not configured/);
    const { ctx: c2 } = makeCtx([], {
      config: { cancellationCodes: { late: 'cancelled (late)' } },
    });
    expect(cancellationCode(c2, 'late cancellation')).toBe('cancelled (late)');
  });
});
