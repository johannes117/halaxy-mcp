import type { HalaxyClient, Query } from '../halaxy/client.js';
import {
  displayName,
  emails,
  mobiles,
  patientFamily,
  patientGivenNames,
} from '../halaxy/summaries.js';
import { PatientSchema, parseEach, type Patient } from '../halaxy/types.js';
import { maskPhone } from './mask.js';

export type MatchLevel = 'exact' | 'likely' | 'possible';
export type Verdict = 'none' | MatchLevel;

export interface DuplicateInput {
  given: string;
  family: string;
  birthDate: string;
  mobile?: string;
  email?: string;
}

export interface DuplicateCandidate {
  id: string;
  match: MatchLevel;
  matched: string[];
  name?: string;
  birthDate?: string;
  mobile?: string;
  email?: string;
}

export interface DuplicateResult {
  verdict: Verdict;
  candidates: DuplicateCandidate[];
  note?: string;
}

/** Case-, accent-, space- and punctuation-insensitive name comparison key. */
export function nameKey(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

const RANK: Record<Verdict, number> = { none: 0, possible: 1, likely: 2, exact: 3 };

/**
 * Score one candidate:
 * - exact: given name, family name and DOB all match
 * - likely: DOB plus one name or a contact detail matches
 * - possible: a contact detail matches, or both names match with a different DOB
 * Returns undefined when nothing meaningful matches (e.g. a search filter Halaxy ignored).
 */
export function scoreCandidate(
  input: DuplicateInput,
  patient: Patient,
): { match: MatchLevel; matched: string[] } | undefined {
  const givenKey = nameKey(input.given);
  const givenMatch =
    givenKey !== '' &&
    patientGivenNames(patient).some((g) => {
      const k = nameKey(g);
      return k === givenKey || nameKey(g.split(/\s+/)[0]) === nameKey(input.given.split(/\s+/)[0]);
    });
  const familyMatch =
    nameKey(input.family) !== '' && nameKey(patientFamily(patient)) === nameKey(input.family);
  const dobMatch = patient.birthDate === input.birthDate;
  const mobileMatch = Boolean(input.mobile && mobiles(patient.telecom).includes(input.mobile));
  const emailMatch = Boolean(
    input.email && emails(patient.telecom).includes(input.email.toLowerCase()),
  );

  const matched: string[] = [];
  if (givenMatch) matched.push('given name');
  if (familyMatch) matched.push('family name');
  if (dobMatch) matched.push('date of birth');
  if (mobileMatch) matched.push('mobile');
  if (emailMatch) matched.push('email');

  const contact = mobileMatch || emailMatch;
  if (givenMatch && familyMatch && dobMatch) return { match: 'exact', matched };
  if (dobMatch && (givenMatch || familyMatch || contact)) return { match: 'likely', matched };
  if (contact || (givenMatch && familyMatch)) return { match: 'possible', matched };
  return undefined;
}

/**
 * Run several searches (family+DOB, given+DOB, given+family, mobile, email), merge and score.
 * Scoring is done client-side, so a search parameter Halaxy silently ignores can only add
 * noise, never hide a real match that another query found.
 */
export async function checkDuplicate(
  client: HalaxyClient,
  input: DuplicateInput,
): Promise<DuplicateResult> {
  const queries: Query[] = [
    { family: input.family, birthdate: input.birthDate },
    { given: input.given, birthdate: input.birthDate },
    { given: input.given, family: input.family },
  ];
  if (input.mobile) queries.push({ phone: input.mobile });
  if (input.email) queries.push({ email: input.email });

  const results = await Promise.all(queries.map((q) => client.search('Patient', q)));
  const byId = new Map<string, Patient>();
  let truncated = false;
  for (const r of results) {
    truncated ||= r.truncated;
    for (const p of parseEach(PatientSchema, r.resources)) byId.set(p.id, p);
  }

  const candidates: DuplicateCandidate[] = [];
  for (const patient of byId.values()) {
    const score = scoreCandidate(input, patient);
    if (!score) continue;
    candidates.push({
      id: patient.id,
      match: score.match,
      matched: score.matched,
      name: displayName(patient.name),
      birthDate: patient.birthDate,
      mobile: maskPhone(mobiles(patient.telecom)[0]),
      email: emails(patient.telecom)[0],
    });
  }
  candidates.sort((a, b) => RANK[b.match] - RANK[a.match]);
  const verdict = candidates.reduce<Verdict>(
    (best, c) => (RANK[c.match] > RANK[best] ? c.match : best),
    'none',
  );
  return {
    verdict,
    candidates: candidates.slice(0, 10),
    ...(truncated
      ? {
          note: 'A search hit the result cap, so some candidates may not have been checked. Review manually in Halaxy.',
        }
      : {}),
  };
}
