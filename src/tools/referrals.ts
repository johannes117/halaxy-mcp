import { z } from 'zod';
import { refMatches } from '../halaxy/refs.js';
import { displayName } from '../halaxy/summaries.js';
import { CoverageSchema, ReferralSchema, parseAs, parseEach } from '../halaxy/types.js';
import { HalaxyApiError } from '../halaxy/client.js';
import { maskMedicare, untrusted } from '../safety/mask.js';
import {
  readAttachmentForCommit,
  resolveAttachment,
  type ResolvedAttachment,
} from '../safety/paths.js';
import { DateSchema, HalaxyIdSchema } from '../safety/validate.js';
import { parseTimeInput, formatInZone, todayInZone } from '../time.js';
import { prepared } from './commit.js';
import {
  NameResolver,
  createdId,
  fetchPatient,
  fetchRole,
  isExternalRole,
  truncationNote,
} from './shared.js';
import { APPROVAL_NOTE, ToolError, UNTRUSTED_NOTE, defineTool, type ToolContext } from './types.js';

export const listReferralsTool = defineTool({
  name: 'halaxy_list_referrals',
  title: "List a patient's referrals",
  kind: 'read',
  description:
    'Lists the referrals on a patient: referrer, created date, whether active, comment and number of attachments. ' +
    'Check this before preparing a new referral to avoid duplicates. ' +
    UNTRUSTED_NOTE,
  input: z.object({ patientId: HalaxyIdSchema }).strict(),
  async handler({ patientId }, ctx) {
    const { resources, truncated } = await ctx.client.search('Referral', {
      subject: ctx.refs.search('Patient', patientId),
    });
    const referrals = parseEach(ReferralSchema, resources).filter((r) =>
      refMatches(r.subject?.reference, 'Patient', patientId),
    );
    const names = new NameResolver(ctx);
    return {
      referrals: await Promise.all(
        referrals.map(async (r) => ({
          id: r.id,
          referrerName: (await names.name(r.requester, 'PractitionerRole')) ?? null,
          created: r.created ?? null,
          active: r.active ?? null,
          comment: untrusted(r.comment) ?? null,
          attachmentCount: r.attachments?.length ?? 0,
        })),
      ),
      ...truncationNote(truncated),
    };
  },
});

interface ReferralPlan {
  body: Record<string, unknown>;
  attachment?: ResolvedAttachment;
}

export function buildReferralBody(
  ctx: Pick<ToolContext, 'refs' | 'config'>,
  args: {
    patientId: string;
    coverageId: string;
    referrerRoleId: string;
    referralDate: string;
    comment?: string;
  },
): Record<string, unknown> {
  const created = formatInZone(
    parseTimeInput(args.referralDate, ctx.config.timezone),
    ctx.config.timezone,
  );
  // Halaxy-specific Referral shape (coverage, created, active, comment, attachments).
  // https://developers.halaxy.com/reference/createreferral
  return {
    resourceType: 'Referral',
    coverage: ctx.refs.ref('Coverage', args.coverageId),
    subject: ctx.refs.ref('Patient', args.patientId),
    requester: ctx.refs.ref('PractitionerRole', args.referrerRoleId),
    created,
    active: true,
    ...(args.comment ? { comment: args.comment } : {}),
  };
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

export const prepareCreateReferralTool = defineTool({
  name: 'halaxy_prepare_create_referral',
  title: 'Prepare: create referral',
  kind: 'write',
  description:
    "Prepares a referral on a patient (does not write yet), linking the patient's coverage and the external referrer (EP- role), optionally attaching the referral PDF/image. " +
    'Prerequisites: the patient exists, a Coverage exists (see halaxy_get_patient), and the referrer exists (halaxy_search_referrers). ' +
    'attachmentPath must be a file inside the configured attachments folder (PDF or image, ≤ 10 MB). Comment example: "MHCP – 6 sessions". ' +
    APPROVAL_NOTE +
    ' ' +
    UNTRUSTED_NOTE,
  input: z
    .object({
      patientId: HalaxyIdSchema,
      coverageId: HalaxyIdSchema,
      referrerRoleId: HalaxyIdSchema.describe(
        'EP- practitioner role id of the referring GP/clinician',
      ),
      referralDate: DateSchema.describe('Date on the referral letter, YYYY-MM-DD'),
      comment: z.string().trim().min(1).max(500).optional(),
      attachmentPath: z.string().trim().min(1).max(1000).optional(),
    })
    .strict(),
  async handler(args, ctx) {
    const warnings: string[] = [];
    const patient = await fetchPatient(ctx, args.patientId);

    let coverage;
    try {
      coverage = parseAs(
        CoverageSchema,
        await ctx.client.get(`Coverage/${encodeURIComponent(args.coverageId)}`),
        'Coverage',
      );
    } catch (err) {
      if (err instanceof HalaxyApiError && err.status === 404)
        throw new ToolError(`No coverage found with id ${args.coverageId}.`);
      throw err;
    }
    if (!refMatches(coverage.beneficiary?.reference, 'Patient', args.patientId)) {
      throw new ToolError('That coverage does not belong to this patient.');
    }
    if (coverage.status && coverage.status !== 'active')
      warnings.push(`Coverage status is "${coverage.status}".`);

    const role = await fetchRole(ctx, args.referrerRoleId);
    if (!isExternalRole(role)) {
      throw new ToolError(
        'referrerRoleId must be an external referrer (EP-) role. Use halaxy_search_referrers.',
      );
    }
    const names = new NameResolver(ctx);
    const referrerName =
      (await names.name(role.practitioner, 'Practitioner')) ?? args.referrerRoleId;

    const today = todayInZone(ctx.config.timezone, ctx.now());
    if (args.referralDate > today)
      warnings.push('⚠️ The referral date is in the future. Re-check it.');
    else if (monthsBetween(args.referralDate, today) >= 12) {
      warnings.push(
        '⚠️ The referral is more than 12 months old; it may no longer be valid for Medicare.',
      );
    }

    const existing = parseEach(
      ReferralSchema,
      (await ctx.client.search('Referral', { subject: ctx.refs.search('Patient', args.patientId) }))
        .resources,
    ).filter((r) => refMatches(r.subject?.reference, 'Patient', args.patientId));
    const sameDay = existing.filter(
      (r) =>
        r.created?.slice(0, 10) === args.referralDate &&
        refMatches(r.requester?.reference, 'PractitionerRole', args.referrerRoleId),
    );
    if (sameDay.length > 0) {
      warnings.push(
        `⚠️ Possible duplicate: a referral from this referrer dated ${args.referralDate} already exists (${sameDay.map((r) => r.id).join(', ')}).`,
      );
    }

    const attachment = args.attachmentPath
      ? await resolveAttachment(ctx.config.attachmentsDir, args.attachmentPath)
      : undefined;
    if (!attachment) warnings.push('No referral document attached.');

    const plan: ReferralPlan = {
      body: buildReferralBody(ctx, args),
      ...(attachment ? { attachment } : {}),
    };
    return prepared(
      ctx,
      {
        tool: 'halaxy_prepare_create_referral',
        resourceType: 'Referral',
        payload: plan,
        async execute(p, c) {
          const body: Record<string, unknown> = { ...p.body };
          if (p.attachment) {
            // Read and base64-encode only now; refuses if the file changed since prepare.
            const data = await readAttachmentForCommit(c.config.attachmentsDir, p.attachment);
            body.attachments = [
              { contentType: p.attachment.contentType, data, title: p.attachment.fileName },
            ];
          }
          const res = await c.client.post('Referral', body);
          return { resourceType: 'Referral', id: createdId(res.body, res.location, 'Referral') };
        },
      },
      {
        action: 'Create referral',
        patient: displayName(patient.name) ?? args.patientId,
        coverage: maskMedicare(coverage.subscriberId, coverage.dependent) ?? args.coverageId,
        referrer: referrerName,
        referralDate: args.referralDate,
        comment: args.comment ?? null,
        attachment: attachment
          ? {
              file: attachment.fileName,
              type: attachment.contentType,
              sizeKB: Math.round(attachment.size / 1024),
            }
          : null,
      },
      warnings,
      existing.length ? { existingReferralCount: existing.length } : {},
    );
  },
});
