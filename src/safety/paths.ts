import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

export interface ResolvedAttachment {
  realPath: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
}

function sniffContentType(head: Buffer): string | undefined {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const box = head.subarray(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|mif1|msf1)$/.test(box)) return 'image/heic';
  return undefined;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * Resolve an attachment path, which must be (after following symlinks) a regular file inside
 * `attachmentsDir`, be a PDF/PNG/JPEG/HEIC by content, and be ≤ 10 MB.
 */
export async function resolveAttachment(
  attachmentsDir: string | undefined,
  inputPath: string,
): Promise<ResolvedAttachment> {
  if (!attachmentsDir) {
    throw new PathError(
      'No attachmentsDir is configured, so attachments are disabled. Run "halaxy-mcp setup".',
    );
  }
  if (inputPath.includes('\0')) throw new PathError('Invalid path.');
  let root: string;
  try {
    root = await realpath(attachmentsDir);
  } catch {
    throw new PathError('The configured attachmentsDir does not exist.');
  }
  const candidate = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
  // Check the lexical path first so "../" tricks are rejected even for missing files.
  if (
    !isInside(root, resolve(candidate)) &&
    !isInside(resolve(attachmentsDir), resolve(candidate))
  ) {
    throw new PathError('Attachment must be inside the configured attachments folder.');
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new PathError('Attachment file not found in the attachments folder.');
  }
  if (!isInside(root, real)) {
    throw new PathError(
      'Attachment resolves (via a link) to a location outside the attachments folder.',
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new PathError('Attachment path is not a regular file.');
  if (info.size === 0) throw new PathError('Attachment file is empty.');
  if (info.size > MAX_ATTACHMENT_BYTES) throw new PathError('Attachment is larger than 10 MB.');

  const handle = await open(real, 'r');
  let head: Buffer;
  try {
    head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
  } finally {
    await handle.close();
  }
  const contentType = sniffContentType(head);
  if (!contentType) throw new PathError('Attachment must be a PDF or an image (PNG, JPEG, HEIC).');

  const sha256 = createHash('sha256')
    .update(await readFile(real))
    .digest('hex');
  return { realPath: real, fileName: basename(real), contentType, size: info.size, sha256 };
}

/**
 * Re-resolve and read an attachment at commit time, refusing if it changed since prepare.
 */
export async function readAttachmentForCommit(
  attachmentsDir: string | undefined,
  expected: ResolvedAttachment,
): Promise<string> {
  const now = await resolveAttachment(attachmentsDir, expected.realPath);
  if (now.realPath !== expected.realPath || now.sha256 !== expected.sha256) {
    throw new PathError(
      'The attachment file changed after it was prepared. Prepare the referral again.',
    );
  }
  return (await readFile(now.realPath)).toString('base64');
}
