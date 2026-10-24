import { z } from 'zod';
import { idFromRef, refMatches } from '../halaxy/refs.js';
import { displayName } from '../halaxy/summaries.js';
import {
  OrganizationSchema,
  PractitionerRoleSchema,
  PractitionerSchema,
  parseEach,
  type ContactPoint,
  type PractitionerRole,
} from '../halaxy/types.js';
import { nameKey } from '../safety/duplicates.js';
import {
  AddressInputSchema,
  EmailSchema,
  PhoneSchema,
  ProviderNumberSchema,
  normaliseProviderNumber,
  normalisePhone,
  providerNumberCheckOk,
} from '../safety/validate.js';
import { prepared } from './commit.js';
import { buildAddress } from './patients.js';
import { NameResolver, createdId, isExternalRole, truncationNote } from './shared.js';
import { APPROVAL_NOTE, ToolError, defineTool, type ToolContext } from './types.js';

/** AU Base identifier system for Medicare provider numbers. */
export const PROVIDER_NUMBER_SYSTEM =
  'http://ns.electronichealth.net.au/id/medicare-provider-number';

export function roleProviderNumber(role: PractitionerRole): string | undefined {
  const ids = role.identifier ?? [];
  const byProvider = ids.find((i) => i.system && /provider/i.test(i.system) && i.value);
  const value =
    byProvider?.value ?? ids.find((i) => i.value && /^\d{5,6}[0-9A-Z]{2}$/i.test(i.value))?.value;
  return value ? normaliseProviderNumber(value) : undefined;
}

export interface ReferrerSummary {
  practitionerRoleId: string;
  name: string | null;
  providerNumber: string | null;
  /** false when Halaxy didn't return identifiers, so the provider-number match couldn't be confirmed. */
  providerNumberVerified: boolean;
  organisation: string | null;
}

export async function searchReferrers(
  ctx: ToolContext,
  args: { name?: string; providerNumber?: string },
): Promise<{ referrers: ReferrerSummary[]; truncated: boolean }> {
  const roles = new Map<string, PractitionerRole>();
  let truncated = false;

  if (args.providerNumber) {
    // https://developers.halaxy.com/reference/findpractitionerrole — providerNumber search param.
    const r = await ctx.client.search('PractitionerRole', { providerNumber: args.providerNumber });
    truncated ||= r.truncated;
    for (const role of parseEach(PractitionerRoleSchema, r.resources)) roles.set(role.id, role);
  }
  if (args.name) {
    const p = await ctx.client.search('Practitioner', { name: args.name }, 20);
    truncated ||= p.truncated;
    const wanted = args.name
      .split(/\s+/)
      .map(nameKey)
      .filter((k) => k.length > 1 && !['dr', 'prof', 'mr', 'mrs', 'ms', 'miss'].includes(k));
    const practitioners = parseEach(PractitionerSchema, p.resources).filter((pr) => {
      const key = nameKey(displayName(pr.name));
      return wanted.every((w) => key.includes(w));
    });
    const lists = await Promise.all(
      practitioners.map((pr) =>
        ctx.client.search(
          'PractitionerRole',
          { practitioner: ctx.refs.search('Practitioner', pr.id) },
          20,
        ),
      ),
    );
    practitioners.forEach((pr, i) => {
      for (const role of parseEach(PractitionerRoleSchema, lists[i]!.resources)) {
        if (refMatches(role.practitioner?.reference, 'Practitioner', pr.id))
          roles.set(role.id, role);
      }
    });
  }

  const names = new NameResolver(ctx);
  const wantedPn = args.providerNumber ? normaliseProviderNumber(args.providerNumber) : undefined;
  const out: ReferrerSummary[] = [];
  for (const role of roles.values()) {
    if (!isExternalRole(role)) continue;
    const pn = roleProviderNumber(role);
    if (wantedPn && pn && pn !== wantedPn && !args.name) continue;
    out.push({
      practitionerRoleId: role.id,
      name: (await names.name(role.practitioner, 'Practitioner')) ?? null,
      providerNumber: pn ?? null,
      providerNumberVerified: wantedPn ? pn === wantedPn : Boolean(pn),
      organisation: (await names.name(role.organization, 'Organization')) ?? null,
    });
  }
  return { referrers: out.slice(0, ctx.client.maxResults), truncated };
}

export const searchReferrersTool = defineTool({
  name: 'halaxy_search_referrers',
  title: 'Search external referrers (GPs)',
  kind: 'read',
  description:
    'Finds external referrers (EP- practitioner roles, e.g. GPs) by name and/or Medicare provider number, with their organisation. ' +
    'Always search before creating a referrer, to avoid duplicate GP records. Use the practitionerRoleId as referrerRoleId on a referral.',
  input: z
    .object({
      name: z.string().trim().min(2).max(200).optional(),
      providerNumber: ProviderNumberSchema.optional(),
    })
    .strict()
    .refine((v) => v.name !== undefined || v.providerNumber !== undefined, {
      message: 'Provide a name or a providerNumber.',
    }),
  async handler(args, ctx) {
    const { referrers, truncated } = await searchReferrers(ctx, args);
    return { referrers, ...truncationNote(truncated) };
  },
});

const TITLES = new Set([
  'dr',
  'doctor',
  'prof',
  'professor',
  'aprof',
  'assocprof',
  'mr',
  'mrs',
  'ms',
  'miss',
  'mx',
]);

export function splitPersonName(full: string): {
  prefix?: string;
  given: string[];
  family: string;
} {
  const tokens = full.trim().split(/\s+/).filter(Boolean);
  let prefix: string | undefined;
  while (tokens.length > 0 && TITLES.has(tokens[0]!.toLowerCase().replace(/[^a-z]/g, ''))) {
    prefix = prefix ? `${prefix} ${tokens.shift()}` : tokens.shift();
  }
  if (tokens.length < 2) {
    throw new ToolError(
      'Referrer name needs at least a given name and a family name (e.g. "Dr Jane Citizen").',
    );
  }
  const family = tokens.pop()!;
  return { ...(prefix ? { prefix } : {}), given: tokens, family };
}

export interface ReferrerPlan {
  practitioner: Record<string, unknown>;
  organization: { existingId: string } | { create: Record<string, unknown> };
  role: { identifier: unknown[]; telecom: ContactPoint[] };
}

export function buildReferrerPlan(
  args: {
    name: string;
    providerNumber: string;
    practiceName?: string;
    phone?: string;
    fax?: string;
    email?: string;
    address?: z.infer<typeof AddressInputSchema>;
  },
  existingOrganizationId?: string,
): ReferrerPlan {
  const { prefix, given, family } = splitPersonName(args.name);
  const telecom: ContactPoint[] = [];
  if (args.phone) {
    const kind = normalisePhone(args.phone)?.kind;
    telecom.push(
      kind === 'mobile'
        ? { system: 'sms', value: args.phone, use: 'mobile' }
        : { system: 'phone', value: args.phone, use: 'work' },
    );
  }
  if (args.fax) telecom.push({ system: 'fax', value: args.fax, use: 'work' });
  if (args.email) telecom.push({ system: 'email', value: args.email, use: 'work' });
  const orgName = args.practiceName ?? `${[...given, family].join(' ')} (practice)`;
  return {
    // Telecom can't be sent on Practitioner; it goes on the PractitionerRole.
    // https://developers.halaxy.com/reference/createpractitioner
    practitioner: {
      resourceType: 'Practitioner',
      name: [{ use: 'official', ...(prefix ? { prefix: [prefix] } : {}), given, family }],
    },
    organization: existingOrganizationId
      ? { existingId: existingOrganizationId }
      : {
          create: {
            resourceType: 'Organization',
            name: orgName,
            ...(args.address ? { address: [{ ...buildAddress(args.address), use: 'work' }] } : {}),
          },
        },
    role: {
      // Halaxy may drop identifiers on create (as it does for Patient); the commit result
      // re-reads the role and reports whether the provider number stuck.
      identifier: [{ system: PROVIDER_NUMBER_SYSTEM, value: args.providerNumber }],
      telecom,
    },
  };
}

export const prepareCreateReferrerTool = defineTool({
  name: 'halaxy_prepare_create_referrer',
  title: 'Prepare: create external referrer',
  kind: 'write',
  description:
    'Prepares a new external referrer (e.g. a GP) as a Halaxy professional contact: a Practitioner, their practice Organization (reused if one with the same name exists) and an external (EP-) PractitionerRole. Does not write yet. ' +
    'It searches first and refuses if a referrer with the same provider number exists. Only use when halaxy_search_referrers found nobody suitable. ' +
    APPROVAL_NOTE,
  input: z
    .object({
      name: z.string().trim().min(3).max(200).describe('e.g. "Dr Jane Citizen"'),
      providerNumber: ProviderNumberSchema,
      practiceName: z.string().trim().min(2).max(200).optional(),
      phone: PhoneSchema.optional(),
      fax: PhoneSchema.optional(),
      email: EmailSchema.optional(),
      address: AddressInputSchema.optional(),
    })
    .strict(),
  async handler(args, ctx) {
    const warnings: string[] = [];
    splitPersonName(args.name);
    if (!providerNumberCheckOk(args.providerNumber)) {
      warnings.push(
        '⚠️ The provider number check character does not validate. Re-check it against the referral letter.',
      );
    }
    const byNumber = await searchReferrers(ctx, { providerNumber: args.providerNumber });
    const verified = byNumber.referrers.filter((r) => r.providerNumberVerified);
    if (verified.length > 0) {
      throw new ToolError('A referrer with this provider number already exists. Use it instead.', {
        existing: verified,
      });
    }
    if (byNumber.referrers.length > 0) {
      warnings.push(
        'Halaxy returned referrers for this provider number search but did not include provider numbers to confirm the match. Check these first: ' +
          byNumber.referrers.map((r) => `${r.name ?? '?'} (${r.practitionerRoleId})`).join(', '),
      );
    }
    const byName = await searchReferrers(ctx, { name: args.name.replace(/^(dr|prof)\.?\s+/i, '') });
    if (byName.referrers.length > 0) {
      warnings.push(
        'Referrers with a similar name already exist (possibly a different practice location): ' +
          byName.referrers
            .map(
              (r) =>
                `${r.name ?? '?'} — ${r.organisation ?? 'no org'} — ${r.providerNumber ?? 'no provider no.'} (${r.practitionerRoleId})`,
            )
            .join('; '),
      );
    }
    let existingOrgId: string | undefined;
    if (args.practiceName) {
      const orgs = parseEach(
        OrganizationSchema,
        (await ctx.client.search('Organization', { name: args.practiceName }, 20)).resources,
      );
      existingOrgId = orgs.find((o) => nameKey(o.name) === nameKey(args.practiceName))?.id;
    } else {
      warnings.push(
        'No practice name given: a placeholder organisation named after the referrer will be created.',
      );
    }
    const plan = buildReferrerPlan(args, existingOrgId);
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_create_referrer',
        resourceType: 'PractitionerRole',
        payload: plan,
        execute: executeReferrerPlan,
      },
      {
        action: 'Create external referrer',
        name: args.name,
        providerNumber: args.providerNumber,
        practice: existingOrgId
          ? `${args.practiceName} (existing organisation ${existingOrgId})`
          : (plan.organization as { create: { name: string } }).create.name + ' (new organisation)',
        phone: args.phone ?? null,
        fax: args.fax ?? null,
        email: args.email ?? null,
        recordsCreated: existingOrgId
          ? ['Practitioner', 'PractitionerRole']
          : ['Practitioner', 'Organization', 'PractitionerRole'],
      },
      warnings,
    );
  },
});

async function executeReferrerPlan(plan: ReferrerPlan, ctx: ToolContext) {
  const created: string[] = [];
  try {
    const pRes = await ctx.client.post('Practitioner', plan.practitioner);
    const practitionerId = createdId(pRes.body, pRes.location, 'Practitioner');
    if (!practitionerId) throw new Error('Halaxy did not return the new Practitioner id');
    created.push(`Practitioner/${practitionerId}`);

    let organizationId: string | undefined;
    if ('existingId' in plan.organization) {
      organizationId = plan.organization.existingId;
    } else {
      const oRes = await ctx.client.post('Organization', plan.organization.create);
      organizationId = createdId(oRes.body, oRes.location, 'Organization');
      if (!organizationId) throw new Error('Halaxy did not return the new Organization id');
      created.push(`Organization/${organizationId}`);
    }

    const rRes = await ctx.client.post('PractitionerRole', {
      resourceType: 'PractitionerRole',
      practitioner: ctx.refs.ref('Practitioner', practitionerId),
      organization: ctx.refs.ref('Organization', organizationId),
      identifier: plan.role.identifier,
      ...(plan.role.telecom.length ? { telecom: plan.role.telecom } : {}),
    });
    const roleId = createdId(rRes.body, rRes.location, 'PractitionerRole');
    created.push(`PractitionerRole/${roleId ?? '?'}`);
    const stored = parseEach(PractitionerRoleSchema, [rRes.body])[0];
    return {
      resourceType: 'PractitionerRole',
      id: roleId,
      details: {
        practitionerId,
        organizationId,
        ...(stored && !roleProviderNumber(stored)
          ? {
              warning:
                'Halaxy did not echo the provider number on the new role. Check it in the Halaxy UI.',
            }
          : {}),
        ...(roleId &&
        !roleId.startsWith('EP-') &&
        idFromRef(stored?.practitioner?.reference)?.startsWith('EP-') !== true
          ? { note: 'The new role id does not have the expected EP- prefix.' }
          : {}),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    throw new Error(
      created.length
        ? `${msg}. Records already created (fix or remove in the Halaxy UI): ${created.join(', ')}`
        : msg,
    );
  }
}
