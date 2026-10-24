import type { Address, ContactPoint, HumanName, Patient } from './types.js';
import { normalisePhone } from '../safety/validate.js';

export function officialName(names: HumanName[] | undefined): HumanName | undefined {
  if (!names || names.length === 0) return undefined;
  return (
    names.find((n) => n.use === 'official') ?? names.find((n) => n.use === 'usual') ?? names[0]
  );
}

export function displayName(names: HumanName[] | undefined): string | undefined {
  const n = officialName(names);
  if (!n) return undefined;
  if (n.given?.length || n.family) {
    return [...(n.prefix ?? []), ...(n.given ?? []), n.family].filter(Boolean).join(' ');
  }
  return n.text;
}

export function mobiles(telecom: ContactPoint[] | undefined): string[] {
  return (telecom ?? [])
    .filter((t) => t.value && (t.system === 'sms' || (t.system === 'phone' && t.use === 'mobile')))
    .map((t) => normalisePhone(t.value!)?.value ?? t.value!);
}

export function phones(telecom: ContactPoint[] | undefined): string[] {
  return (telecom ?? [])
    .filter((t) => t.value && (t.system === 'sms' || t.system === 'phone'))
    .map((t) => normalisePhone(t.value!)?.value ?? t.value!);
}

export function emails(telecom: ContactPoint[] | undefined): string[] {
  return (telecom ?? [])
    .filter((t) => t.system === 'email' && t.value)
    .map((t) => t.value!.trim().toLowerCase());
}

export function formatAddress(address: Address | undefined): string | undefined {
  if (!address) return undefined;
  const parts = [...(address.line ?? []), address.city, address.state, address.postalCode].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(', ') : address.text;
}

export function patientGivenNames(p: Patient): string[] {
  return officialName(p.name)?.given ?? [];
}

export function patientFamily(p: Patient): string | undefined {
  return officialName(p.name)?.family;
}
