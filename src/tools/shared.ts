import { idFromRef, type ResourceType } from '../halaxy/refs.js';
import { displayName } from '../halaxy/summaries.js';
import {
  HealthcareServiceSchema,
  PatientSchema,
  PractitionerRoleSchema,
  PractitionerSchema,
  OrganizationSchema,
  parseAs,
  type HealthcareService,
  type Patient,
  type PractitionerRole,
  type Reference,
} from '../halaxy/types.js';
import { HalaxyApiError } from '../halaxy/client.js';
import { ToolError, type ToolContext } from './types.js';

/** Internal scan size for searches that are filtered client-side before output. */
export const SCAN_CAP = 500;

export function isPracticeRole(role: PractitionerRole): boolean {
  return (
    role.id.startsWith('PR-') || (idFromRef(role.practitioner?.reference) ?? '').startsWith('PR-')
  );
}

export function isExternalRole(role: PractitionerRole): boolean {
  return (
    role.id.startsWith('EP-') || (idFromRef(role.practitioner?.reference) ?? '').startsWith('EP-')
  );
}

async function getOr404<T>(
  ctx: ToolContext,
  fn: () => Promise<T>,
  what: string,
  id: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HalaxyApiError && (err.status === 404 || err.status === 410)) {
      throw new ToolError(`No ${what} found with id ${id}.`);
    }
    throw err;
  }
}

export async function fetchPatient(ctx: ToolContext, id: string): Promise<Patient> {
  return getOr404(
    ctx,
    async () =>
      parseAs(PatientSchema, await ctx.client.get(`Patient/${encodeURIComponent(id)}`), 'Patient'),
    'patient',
    id,
  );
}

export async function fetchRole(ctx: ToolContext, id: string): Promise<PractitionerRole> {
  return getOr404(
    ctx,
    async () =>
      parseAs(
        PractitionerRoleSchema,
        await ctx.client.get(`PractitionerRole/${encodeURIComponent(id)}`),
        'PractitionerRole',
      ),
    'practitioner role',
    id,
  );
}

export async function fetchService(ctx: ToolContext, id: string): Promise<HealthcareService> {
  return getOr404(
    ctx,
    async () =>
      parseAs(
        HealthcareServiceSchema,
        await ctx.client.get(`HealthcareService/${encodeURIComponent(id)}`),
        'HealthcareService',
      ),
    'service',
    id,
  );
}

/**
 * Resolves display names for references within a single tool call. Nothing is cached
 * across calls (no patient data is kept between calls).
 */
export class NameResolver {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  private lookups = 0;

  constructor(
    private readonly ctx: ToolContext,
    private readonly maxLookups = 50,
  ) {}

  async name(ref: Reference | undefined, type: ResourceType): Promise<string | undefined> {
    if (!ref) return undefined;
    if (ref.display) return ref.display;
    const id = idFromRef(ref.reference);
    if (!id) return undefined;
    const key = `${type}/${id}`;
    let p = this.cache.get(key);
    if (!p) {
      if (this.lookups >= this.maxLookups) return undefined;
      this.lookups++;
      p = this.lookup(type, id).catch(() => undefined);
      this.cache.set(key, p);
    }
    return p;
  }

  private async lookup(type: ResourceType, id: string): Promise<string | undefined> {
    const path = `${type}/${encodeURIComponent(id)}`;
    const body = await this.ctx.client.get(path);
    switch (type) {
      case 'Patient':
        return displayName(parseAs(PatientSchema, body, type).name);
      case 'Practitioner':
        return displayName(parseAs(PractitionerSchema, body, type).name);
      case 'PractitionerRole': {
        const role = parseAs(PractitionerRoleSchema, body, type);
        return this.name(role.practitioner, 'Practitioner');
      }
      case 'Organization':
        return parseAs(OrganizationSchema, body, type).name;
      case 'HealthcareService':
        return parseAs(HealthcareServiceSchema, body, type).name;
      default:
        return undefined;
    }
  }
}

/** Pull the created resource id out of a create/operation response. */
export function createdId(
  body: unknown,
  location: string | undefined,
  resourceType: string,
): string | undefined {
  const find = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const r = value as Record<string, unknown>;
    if (r.resourceType === resourceType && typeof r.id === 'string') return r.id;
    if (r.resourceType === 'Bundle' && Array.isArray(r.entry)) {
      for (const e of r.entry as Array<{ resource?: unknown }>) {
        const id = find(e.resource);
        if (id) return id;
      }
    }
    if (r.resourceType === 'Parameters' && Array.isArray(r.parameter)) {
      for (const p of r.parameter as Array<{ resource?: unknown }>) {
        const id = find(p.resource);
        if (id) return id;
      }
    }
    return undefined;
  };
  const fromBody = find(body);
  if (fromBody) return fromBody;
  if (location) {
    const parts = location.split('/_history')[0]!.split('/');
    const i = parts.lastIndexOf(resourceType);
    if (i >= 0 && parts[i + 1]) return decodeURIComponent(parts[i + 1]!);
  }
  return undefined;
}

export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age--;
  return age;
}

export function truncationNote(truncated: boolean): Record<string, string> {
  return truncated
    ? { truncated: 'More results exist than were returned (cap reached). Narrow the search.' }
    : {};
}
