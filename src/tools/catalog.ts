import { z } from 'zod';
import {
  HealthcareServiceSchema,
  PractitionerRoleSchema,
  parseEach,
  type HealthcareService,
} from '../halaxy/types.js';
import { NameResolver, SCAN_CAP, isPracticeRole, truncationNote } from './shared.js';
import { defineTool } from './types.js';

export const listPractitionersTool = defineTool({
  name: 'halaxy_list_practitioners',
  title: 'List practice clinicians',
  kind: 'read',
  description:
    "Lists the practice's own clinicians (PR- practitioner roles) with their practitionerRoleId. " +
    'Use this to get the practitionerRoleId needed for finding available times, listing appointments and booking. ' +
    'External referrers such as GPs (EP- roles) are excluded; use halaxy_search_referrers for those.',
  input: z.object({}).strict(),
  async handler(_args, ctx) {
    const { resources, truncated } = await ctx.client.search('PractitionerRole', {}, SCAN_CAP);
    const roles = parseEach(PractitionerRoleSchema, resources).filter(
      (r) => isPracticeRole(r) && r.active !== false,
    );
    const names = new NameResolver(ctx);
    const practitioners = await Promise.all(
      roles.slice(0, ctx.client.maxResults).map(async (r) => ({
        practitionerRoleId: r.id,
        name: (await names.name(r.practitioner, 'Practitioner')) ?? null,
      })),
    );
    return {
      practitioners,
      ...truncationNote(truncated || roles.length > ctx.client.maxResults),
    };
  },
});

/** Halaxy may expose a default duration as an extension; read it if present. */
export function serviceDuration(service: HealthcareService): number | undefined {
  for (const ext of service.extension ?? []) {
    if (!ext.url || !/duration/i.test(ext.url)) continue;
    const e = ext as Record<string, unknown>;
    if (typeof e.valueInteger === 'number') return e.valueInteger;
    if (typeof e.valueDecimal === 'number') return e.valueDecimal;
    const q = (e.valueDuration ?? e.valueQuantity) as
      { value?: unknown; unit?: unknown; code?: unknown } | undefined;
    if (q && typeof q.value === 'number') {
      const unit = String(q.code ?? q.unit ?? 'min');
      return /^h/.test(unit) ? q.value * 60 : q.value;
    }
  }
  return undefined;
}

export const listServicesTool = defineTool({
  name: 'halaxy_list_services',
  title: 'List services',
  kind: 'read',
  description:
    "Lists the practice's services (Halaxy HealthcareServices, e.g. counselling, assessment, report writing) with their id and, where Halaxy provides it, the default duration. " +
    'Use the id as healthcareServiceId when booking.',
  input: z.object({}).strict(),
  async handler(_args, ctx) {
    const { resources, truncated } = await ctx.client.search('HealthcareService', {});
    const services = parseEach(HealthcareServiceSchema, resources)
      .filter((s) => s.active !== false)
      .map((s) => {
        const durationMinutes = serviceDuration(s);
        return { id: s.id, name: s.name ?? null, ...(durationMinutes ? { durationMinutes } : {}) };
      });
    return { services, ...truncationNote(truncated) };
  },
});
