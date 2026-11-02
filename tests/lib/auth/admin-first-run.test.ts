import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// First-run setup lets any visitor create the first admin, so it must only open when the admins
// file really is empty: a file that cannot be read or parsed is not "no admins".

vi.mock('fs');
vi.mock('@/lib/edition', () => ({ isOSS: () => true }));

import { isFirstRun, bootstrapFirstAdminWithPassword } from '../../../src/lib/auth/admin';

describe('admin first-run setup', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();
  });

  it('stays closed when the admins file is corrupt', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{"admins": [{"email": "owner@dnacompute.com"');

    expect(() => isFirstRun()).toThrow();
    await expect(bootstrapFirstAdminWithPassword('attacker@dnacompute.com', 'long-enough-password')).rejects.toThrow();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('stays closed when the admins file cannot be read', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('EACCES: permission denied'); });

    expect(() => isFirstRun()).toThrow();
  });

  it('opens when the admins file is empty', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ admins: [] }));

    expect(isFirstRun()).toBe(true);
  });
});
