import type { Region } from '../config.js';

// https://developers.halaxy.com/docs (Getting started → Base URLs)
const BASE_URLS: Record<Region, string> = {
  au: 'https://au-api.halaxy.com/main/',
  eu: 'https://eu-api.halaxy.com/main/',
};

export function baseUrlFor(region: Region): string {
  return BASE_URLS[region];
}

export type ResourceType =
  | 'Patient'
  | 'Coverage'
  | 'Appointment'
  | 'Referral'
  | 'Practitioner'
  | 'PractitionerRole'
  | 'Organization'
  | 'HealthcareService';

const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

export function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid Halaxy id: ${JSON.stringify(id)}`);
  return id;
}

export class Refs {
  constructor(readonly base: string) {}

  /** Full-URL reference for payloads. Halaxy rejects bare ids in references. */
  full(type: ResourceType, id: string): string {
    return `${this.base}${type}/${encodeURIComponent(assertId(id))}`;
  }

  /** `{ reference, type }` object for payloads. */
  ref(type: ResourceType, id: string): { reference: string; type: ResourceType } {
    return { reference: this.full(type, id), type };
  }

  /** `Type/id` value for polymorphic search params. A bare id returns 422. */
  search(type: ResourceType, id: string): string {
    return `${type}/${assertId(id)}`;
  }
}

/** Extract the id from a reference such as `https://…/main/Patient/123`, `Patient/123` or `123`. */
export function idFromRef(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const clean = reference.split('?')[0]!.replace(/\/+$/, '');
  const last = clean.split('/').pop();
  return last ? decodeURIComponent(last) : undefined;
}

/** True if `reference` points at the given resource type and id (any reference form). */
export function refMatches(reference: string | undefined, type: ResourceType, id: string): boolean {
  if (!reference) return false;
  const clean = reference.split('?')[0]!.replace(/\/+$/, '');
  const parts = clean.split('/');
  const refId = parts.pop();
  const refType = parts.pop();
  return (
    refId !== undefined &&
    decodeURIComponent(refId) === id &&
    (refType === undefined || refType === type)
  );
}
