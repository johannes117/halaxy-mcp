import { z } from 'zod';
import { idFromRef, refMatches } from '../halaxy/refs.js';
import { displayName } from '../halaxy/summaries.js';
import {
  AppointmentSchema,
  parseAs,
  parseEach,
  type Appointment,
  type Reference,
} from '../halaxy/types.js';
import { HalaxyApiError } from '../halaxy/client.js';
import { DateOrDateTimeSchema, HalaxyIdSchema } from '../safety/validate.js';
import { formatInZone, parseTimeInput, TimeInputError, toZone } from '../time.js';
import { prepared } from './commit.js';
import {
  NameResolver,
  createdId,
  fetchPatient,
  fetchRole,
  fetchService,
  isPracticeRole,
  truncationNote,
} from './shared.js';
import { APPROVAL_NOTE, ToolError, UNTRUSTED_NOTE, defineTool, type ToolContext } from './types.js';

const MAX_RANGE_DAYS = 62;
const DAY_MS = 86_400_000;

function range(ctx: ToolContext, from: string, to: string): { start: Date; end: Date } {
  try {
    const start = parseTimeInput(from, ctx.config.timezone);
    const end = parseTimeInput(to, ctx.config.timezone, true);
    if (end <= start) throw new ToolError('"to" must be after "from".');
    if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new ToolError(`Date range is limited to ${MAX_RANGE_DAYS} days.`);
    }
    return { start, end };
  } catch (err) {
    if (err instanceof TimeInputError) throw new ToolError(err.message);
    throw err;
  }
}

function participantOf(
  appt: Appointment,
  type: 'Patient' | 'PractitionerRole' | 'HealthcareService',
) {
  return appt.participant?.find(
    (p) => p.actor?.type === type || (p.actor?.reference ?? '').includes(`${type}/`),
  );
}

export interface Slot {
  start: string;
  end: string;
}

/**
 * Query Halaxy's find-available operation.
 * https://developers.halaxy.com/reference/findavailableappointments — GET Appointment/$find,
 * required start, end, duration (minutes). Results honour Online Booking Preferences.
 */
export async function findAvailable(
  ctx: ToolContext,
  practitionerRoleId: string,
  start: Date,
  end: Date,
  durationMinutes: number,
): Promise<{ slots: Slot[]; dates: Array<{ start: Date; end: Date }> }> {
  const tz = ctx.config.timezone;
  const body = await ctx.client.get<{ entry?: Array<{ resource?: unknown }> }>(
    'Appointment/$find',
    {
      start: formatInZone(start, tz),
      end: formatInZone(end, tz),
      duration: durationMinutes,
      'practitioner-role': ctx.refs.search('PractitionerRole', practitionerRoleId),
    },
  );
  const seen = new Set<string>();
  const dates: Array<{ start: Date; end: Date }> = [];
  for (const entry of body?.entry ?? []) {
    const r = AppointmentSchema.safeParse(entry.resource);
    if (!r.success || !r.data.start) continue;
    // Guard against an ignored practitioner filter: drop slots naming another role.
    const roleRefs = (r.data.participant ?? [])
      .map((p) => p.actor?.reference)
      .filter((ref): ref is string => Boolean(ref && ref.includes('PractitionerRole/')));
    if (
      roleRefs.length > 0 &&
      !roleRefs.some((ref) => refMatches(ref, 'PractitionerRole', practitionerRoleId))
    ) {
      continue;
    }
    const s = new Date(r.data.start);
    const e = r.data.end ? new Date(r.data.end) : new Date(s.getTime() + durationMinutes * 60_000);
    if (Number.isNaN(s.getTime()) || s < start || e > end || seen.has(s.toISOString())) continue;
    seen.add(s.toISOString());
    dates.push({ start: s, end: e });
  }
  dates.sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    slots: dates.map((d) => ({ start: formatInZone(d.start, tz), end: formatInZone(d.end, tz) })),
    dates,
  };
}

const DurationSchema = z.number().int().min(5).max(480);

export const findAvailableTimesTool = defineTool({
  name: 'halaxy_find_available_times',
  title: 'Find available appointment times',
  kind: 'read',
  description:
    "Finds open appointment times for one of the practice's clinicians (from halaxy_list_practitioners) between two dates, honouring Halaxy's online booking preferences. " +
    'from/to accept YYYY-MM-DD or YYYY-MM-DDTHH:mm in practice time. Times are returned in the practice timezone with an explicit offset. ' +
    'healthcareServiceId is optional and only used to confirm the service exists.',
  input: z
    .object({
      practitionerRoleId: HalaxyIdSchema,
      healthcareServiceId: HalaxyIdSchema.optional(),
      from: DateOrDateTimeSchema,
      to: DateOrDateTimeSchema,
      durationMinutes: DurationSchema,
      limit: z.number().int().min(1).max(50).default(10),
    })
    .strict(),
  async handler(args, ctx) {
    const { start, end } = range(ctx, args.from, args.to);
    if (args.healthcareServiceId) await fetchService(ctx, args.healthcareServiceId);
    const { slots } = await findAvailable(
      ctx,
      args.practitionerRoleId,
      start,
      end,
      args.durationMinutes,
    );
    return {
      timezone: ctx.config.timezone,
      slots: slots.slice(0, args.limit),
      ...(slots.length > args.limit
        ? { more: `${slots.length - args.limit} more slots in this range.` }
        : {}),
    };
  },
});

export function patientStatus(appt: Appointment): string | undefined {
  const patient = participantOf(appt, 'Patient');
  const coding = patient?.modifierExtension?.find((m) =>
    /appointment-participant-status/.test(m.url ?? ''),
  )?.valueCoding;
  return coding?.code ?? coding?.display ?? appt.status;
}

export const listAppointmentsTool = defineTool({
  name: 'halaxy_list_appointments',
  title: 'List appointments',
  kind: 'read',
  description:
    'Lists appointments between two dates, optionally for one clinician (practitionerRoleId) and/or patient. ' +
    'Returns id, start/end in practice time, clinician, patient, service and status. ' +
    UNTRUSTED_NOTE,
  input: z
    .object({
      from: DateOrDateTimeSchema,
      to: DateOrDateTimeSchema,
      practitionerRoleId: HalaxyIdSchema.optional(),
      patientId: HalaxyIdSchema.optional(),
    })
    .strict(),
  async handler(args, ctx) {
    const tz = ctx.config.timezone;
    const { start, end } = range(ctx, args.from, args.to);
    const { resources, truncated } = await ctx.client.search('Appointment', {
      date: [`ge${formatInZone(start, tz)}`, `le${formatInZone(end, tz)}`],
      ...(args.practitionerRoleId
        ? { actor: ctx.refs.search('PractitionerRole', args.practitionerRoleId) }
        : {}),
      ...(args.patientId ? { patient: ctx.refs.search('Patient', args.patientId) } : {}),
    });
    // Re-apply every filter client-side; Halaxy ignores some search params silently.
    const appts = parseEach(AppointmentSchema, resources).filter((a) => {
      if (!a.id || !a.start) return false;
      const s = new Date(a.start);
      if (s < start || s > end) return false;
      if (
        args.practitionerRoleId &&
        !refMatches(
          participantOf(a, 'PractitionerRole')?.actor?.reference,
          'PractitionerRole',
          args.practitionerRoleId,
        )
      ) {
        return false;
      }
      if (
        args.patientId &&
        !refMatches(participantOf(a, 'Patient')?.actor?.reference, 'Patient', args.patientId)
      ) {
        return false;
      }
      return true;
    });
    appts.sort((a, b) => new Date(a.start!).getTime() - new Date(b.start!).getTime());
    const names = new NameResolver(ctx);
    const serviceName = async (a: Appointment, ref: Reference | undefined) =>
      ref
        ? names.name(ref, 'HealthcareService')
        : (a.serviceType?.[0]?.text ?? a.serviceType?.[0]?.coding?.[0]?.display);
    return {
      timezone: tz,
      appointments: await Promise.all(
        appts.map(async (a) => ({
          id: a.id,
          start: toZone(a.start, tz),
          end: toZone(a.end, tz) ?? null,
          practitionerName:
            (await names.name(participantOf(a, 'PractitionerRole')?.actor, 'PractitionerRole')) ??
            null,
          patientName: (await names.name(participantOf(a, 'Patient')?.actor, 'Patient')) ?? null,
          serviceName: (await serviceName(a, participantOf(a, 'HealthcareService')?.actor)) ?? null,
          status: patientStatus(a) ?? null,
        })),
      ),
      ...truncationNote(truncated),
    };
  },
});

// ---------- booking ----------

export function buildBookParameters(
  ctx: Pick<ToolContext, 'refs'>,
  args: {
    patientId: string;
    practitionerRoleId: string;
    healthcareServiceId: string;
    start: string;
    end: string;
    durationMinutes: number;
    locationType: 'clinic' | 'telehealth';
    comment?: string;
  },
): Record<string, unknown> {
  // https://developers.halaxy.com/reference/createappointment — Appointment/$book takes a
  // Parameters resource; appointment properties go in appt-resource.
  return {
    resourceType: 'Parameters',
    parameter: [
      {
        name: 'appt-resource',
        resource: {
          resourceType: 'Appointment',
          start: args.start,
          end: args.end,
          minutesDuration: args.durationMinutes,
          ...(args.comment ? { comment: args.comment } : {}),
          participant: [{ actor: ctx.refs.ref('PractitionerRole', args.practitionerRoleId) }],
        },
      },
      { name: 'patient-id', valueReference: ctx.refs.ref('Patient', args.patientId) },
      {
        name: 'healthcare-service-id',
        valueReference: ctx.refs.ref('HealthcareService', args.healthcareServiceId),
      },
      { name: 'location-type', valueCode: args.locationType },
      { name: 'status', valueCode: 'booked' },
      // Return 409 instead of silently double-booking.
      { name: 'fail-on-double-booking', valueBoolean: true },
    ],
  };
}

export const prepareBookAppointmentTool = defineTool({
  name: 'halaxy_prepare_book_appointment',
  title: 'Prepare: book appointment',
  kind: 'write',
  description:
    'Prepares booking an appointment (does not write yet). Re-checks that the slot is still free; use halaxy_find_available_times to choose a start time first. ' +
    'start accepts YYYY-MM-DDTHH:mm in practice time (or an ISO datetime with offset). Booking in Halaxy also creates an invoice for the appointment. ' +
    APPROVAL_NOTE,
  input: z
    .object({
      patientId: HalaxyIdSchema,
      practitionerRoleId: HalaxyIdSchema,
      healthcareServiceId: HalaxyIdSchema,
      start: DateOrDateTimeSchema,
      durationMinutes: DurationSchema,
      locationType: z.enum(['clinic', 'telehealth']).default('clinic'),
      comment: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  async handler(args, ctx) {
    const tz = ctx.config.timezone;
    if (!/T\d{2}:\d{2}/.test(args.start))
      throw new ToolError('start must include a time, e.g. 2026-03-02T10:00.');
    let start: Date;
    try {
      start = parseTimeInput(args.start, tz);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : 'Invalid start');
    }
    if (start <= ctx.now()) throw new ToolError('That time is in the past.');
    const end = new Date(start.getTime() + args.durationMinutes * 60_000);

    const [patient, role, service] = await Promise.all([
      fetchPatient(ctx, args.patientId),
      fetchRole(ctx, args.practitionerRoleId),
      fetchService(ctx, args.healthcareServiceId),
    ]);
    if (!isPracticeRole(role)) {
      throw new ToolError(
        "practitionerRoleId must be one of the practice's clinicians (PR- role).",
      );
    }

    // Re-check availability across the rest of that day.
    const windowEnd = new Date(Math.max(end.getTime(), start.getTime() + DAY_MS / 2));
    const { slots, dates } = await findAvailable(
      ctx,
      args.practitionerRoleId,
      start,
      windowEnd,
      args.durationMinutes,
    );
    const ok = dates.some(
      (d) => d.start.getTime() === start.getTime() && d.end.getTime() >= end.getTime(),
    );
    if (!ok) {
      throw new ToolError('That time is no longer available for this clinician.', {
        alternativesSameDay: slots.slice(0, 3),
      });
    }

    const names = new NameResolver(ctx);
    const payload = buildBookParameters(ctx, {
      ...args,
      start: formatInZone(start, tz),
      end: formatInZone(end, tz),
    });
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_book_appointment',
        resourceType: 'Appointment',
        payload,
        async execute(body, c) {
          const res = await c.client.post('Appointment/$book', body);
          return {
            resourceType: 'Appointment',
            id: createdId(res.body, res.location, 'Appointment'),
          };
        },
      },
      {
        action: 'Book appointment',
        patient: displayName(patient.name) ?? args.patientId,
        clinician: (await names.name(role.practitioner, 'Practitioner')) ?? args.practitionerRoleId,
        service: service.name ?? args.healthcareServiceId,
        start: formatInZone(start, tz),
        end: formatInZone(end, tz),
        durationMinutes: args.durationMinutes,
        location: args.locationType,
        comment: args.comment ?? null,
      },
      [
        'Booking creates an invoice in Halaxy for this appointment (Halaxy may also create a clinical note and reminders).',
      ],
    );
  },
});

// ---------- cancellation ----------

export const DEFAULT_NO_CHARGE_CODE = 'cancelled (no charge)';

export function cancellationCode(
  ctx: Pick<ToolContext, 'config'>,
  reason: 'no charge' | 'late cancellation',
): string {
  if (reason === 'no charge')
    return ctx.config.cancellationCodes?.noCharge ?? DEFAULT_NO_CHARGE_CODE;
  const late = ctx.config.cancellationCodes?.late;
  if (!late) {
    // The late-cancellation code could not be verified against Halaxy's docs, so it must be
    // configured explicitly rather than guessed. See README → "Cancellation codes".
    throw new ToolError(
      'Late cancellations are not configured. Set "cancellationCodes.late" in config.json to the exact Halaxy appointment-participant-status code (see README), or cancel in the Halaxy UI.',
    );
  }
  return late;
}

export function buildCancelPatch(
  ctx: Pick<ToolContext, 'client'>,
  appt: Appointment,
  code: string,
): Record<string, unknown> {
  const origin = new URL(ctx.client.base).origin;
  const ext = {
    url: 'https://terminology.halaxy.com/StructureDefinition/appointment-participant-status',
    valueCoding: {
      system: `${origin}/presets/CodeSystem/appointment-participant-status`,
      code,
      display: code,
    },
  };
  // Merge-patch replaces arrays wholesale, so send every participant back unchanged except
  // the patient, whose status modifierExtension is set.
  const participant = (appt.participant ?? []).map((p) => {
    const isPatient =
      p.actor?.type === 'Patient' || (p.actor?.reference ?? '').includes('Patient/');
    if (!isPatient) return p;
    const others = (p.modifierExtension ?? []).filter((m) => m.url !== ext.url);
    return { ...p, modifierExtension: [...others, ext] };
  });
  return { participant };
}

export const prepareCancelAppointmentTool = defineTool({
  name: 'halaxy_prepare_cancel_appointment',
  title: 'Prepare: cancel appointment',
  kind: 'write',
  description:
    'Prepares cancelling an appointment for the patient (does not write yet). reason "no charge" sets the invoice to $0; "late cancellation" applies the late-cancellation status (must be configured). ' +
    APPROVAL_NOTE,
  input: z
    .object({
      appointmentId: HalaxyIdSchema,
      reason: z.enum(['no charge', 'late cancellation']),
    })
    .strict(),
  async handler(args, ctx) {
    const code = cancellationCode(ctx, args.reason);
    let appt: Appointment;
    try {
      appt = parseAs(
        AppointmentSchema,
        await ctx.client.get(`Appointment/${encodeURIComponent(args.appointmentId)}`),
        'Appointment',
      );
    } catch (err) {
      if (err instanceof HalaxyApiError && err.status === 404) {
        throw new ToolError(`No appointment found with id ${args.appointmentId}.`);
      }
      throw err;
    }
    const patientP = participantOf(appt, 'Patient');
    if (!patientP?.actor?.reference)
      throw new ToolError('This appointment has no patient participant to cancel.');
    const current = patientStatus(appt) ?? '';
    if (/cancel/i.test(current) || appt.status === 'cancelled') {
      throw new ToolError(`This appointment is already cancelled (${current}).`);
    }
    const warnings: string[] = [];
    if (appt.start && new Date(appt.start) < ctx.now())
      warnings.push('This appointment is in the past.');
    const names = new NameResolver(ctx);
    const patch = buildCancelPatch(ctx, appt, code);
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_cancel_appointment',
        resourceType: 'Appointment',
        payload: { id: args.appointmentId, patch },
        async execute(p, c) {
          await c.client.patch(`Appointment/${encodeURIComponent(p.id)}`, p.patch);
          return { resourceType: 'Appointment', id: p.id };
        },
      },
      {
        action: 'Cancel appointment',
        appointmentId: args.appointmentId,
        start: toZone(appt.start, ctx.config.timezone) ?? null,
        patient:
          (await names.name(patientP.actor, 'Patient')) ?? idFromRef(patientP.actor.reference),
        clinician:
          (await names.name(participantOf(appt, 'PractitionerRole')?.actor, 'PractitionerRole')) ??
          null,
        reason: args.reason,
        halaxyStatusCode: code,
      },
      warnings,
    );
  },
});
