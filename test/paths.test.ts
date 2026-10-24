import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAttachmentForCommit, resolveAttachment } from '../src/safety/paths.js';
import { tempDir } from './helpers.js';

function setup() {
  const root = tempDir();
  const dir = join(root, 'ingest');
  const outside = join(root, 'outside');
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(dir, 'referral.pdf'), '%PDF-1.4\nsynthetic test referral\n');
  writeFileSync(join(dir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  writeFileSync(join(dir, 'notes.txt'), 'plain text');
  writeFileSync(join(outside, 'secret.pdf'), '%PDF-1.4\noutside\n');
  return { dir, outside };
}

describe('attachment path checks', () => {
  it('accepts PDFs and images inside the folder (relative or absolute)', async () => {
    const { dir } = setup();
    const a = await resolveAttachment(dir, 'referral.pdf');
    expect(a.contentType).toBe('application/pdf');
    expect(a.fileName).toBe('referral.pdf');
    const b = await resolveAttachment(dir, join(dir, 'photo.jpg'));
    expect(b.contentType).toBe('image/jpeg');
  });
  it('rejects ../ escapes and absolute paths outside', async () => {
    const { dir, outside } = setup();
    await expect(resolveAttachment(dir, '../outside/secret.pdf')).rejects.toThrow(
      /inside the configured/,
    );
    await expect(resolveAttachment(dir, join(outside, 'secret.pdf'))).rejects.toThrow(
      /inside the configured/,
    );
  });
  // Creating symlinks needs elevated rights on Windows.
  it.skipIf(process.platform === 'win32')('rejects symlinks that escape the folder', async () => {
    const { dir, outside } = setup();
    symlinkSync(join(outside, 'secret.pdf'), join(dir, 'link.pdf'));
    await expect(resolveAttachment(dir, 'link.pdf')).rejects.toThrow(
      /outside the attachments folder/,
    );
  });
  it('rejects non-PDF/image content, directories, and large files', async () => {
    const { dir } = setup();
    await expect(resolveAttachment(dir, 'notes.txt')).rejects.toThrow(/PDF or an image/);
    mkdirSync(join(dir, 'sub'));
    await expect(resolveAttachment(dir, 'sub')).rejects.toThrow(/not a regular file/);
    writeFileSync(
      join(dir, 'big.pdf'),
      Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]),
    );
    await expect(resolveAttachment(dir, 'big.pdf')).rejects.toThrow(/10 MB/);
  });
  it('requires a configured folder', async () => {
    await expect(resolveAttachment(undefined, 'x.pdf')).rejects.toThrow(/No attachmentsDir/);
  });
  it('refuses to commit a file that changed after prepare', async () => {
    const { dir } = setup();
    const a = await resolveAttachment(dir, 'referral.pdf');
    expect(Buffer.from(await readAttachmentForCommit(dir, a), 'base64').toString()).toContain(
      '%PDF',
    );
    writeFileSync(join(dir, 'referral.pdf'), '%PDF-1.4\nswapped\n');
    await expect(readAttachmentForCommit(dir, a)).rejects.toThrow(/changed/);
  });
});
