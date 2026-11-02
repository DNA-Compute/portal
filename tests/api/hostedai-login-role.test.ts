import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// hosted.ai saves the role a one-time login is created with, so this button must use the member's
// own role. Team admin for everyone handed read-only members full control of the owner's team.

const auth = vi.hoisted(() => ({ role: 'readOnlyMember', isOwner: false }));
vi.mock('@/lib/auth/helpers', () => ({
  getAuthenticatedCustomer: vi.fn(async () => ({
    payload: { email: 'viewer@example.com' },
    teamId: 'team_owner',
    membership: { role: auth.role, isOwner: auth.isOwner },
  })),
}));
const createOneTimeLogin = vi.fn(async (params: unknown) => ({ url: 'https://hai.example/otl', expires_at: 'soon', params }));
vi.mock('@/lib/hostedai', () => ({
  ensureRoles: vi.fn(async () => ({ teamAdmin: 'role-admin', teamMember: 'role-member', readOnlyMember: 'role-readonly', financeManager: 'role-finance' })),
  createOneTimeLogin: (params: unknown) => createOneTimeLogin(params),
}));

import { POST } from '@/app/api/account/hostedai-login/route';

const login = () => POST(new NextRequest('http://localhost/api/account/hostedai-login', { method: 'POST' }));

describe('POST /api/account/hostedai-login', () => {
  beforeEach(() => createOneTimeLogin.mockClear());

  it('logs a read-only member in as read-only, not as team admin', async () => {
    Object.assign(auth, { role: 'readOnlyMember', isOwner: false });
    expect((await login()).status).toBe(200);
    expect(createOneTimeLogin).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team_owner', roleId: 'role-readonly' }));
  });

  it('logs the owner in as team admin', async () => {
    Object.assign(auth, { role: 'readOnlyMember', isOwner: true });
    await login();
    expect(createOneTimeLogin).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'role-admin' }));
  });
});
