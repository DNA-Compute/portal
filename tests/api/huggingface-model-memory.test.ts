import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Each lookup makes the server fetch from Hugging Face, and the file decides how much: so only
// logged-in customers may ask, and a crafted header cannot make the server download gigabytes.

const auth = vi.hoisted(() => ({ loggedIn: true }));
vi.mock('@/lib/auth/helpers', () => ({
  getAuthenticatedCustomer: vi.fn(async () => (auth.loggedIn
    ? { accountId: 'cus' }
    : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

import { GET } from '@/app/api/huggingface/model-memory/route';

const lookup = (modelId: string) => GET(new NextRequest(`http://localhost/api/huggingface/model-memory?modelId=${encodeURIComponent(modelId)}`));

/** A safetensors file whose first 8 bytes claim a header of the given size. */
function headerClaiming(bytes: number) {
  const buffer = new ArrayBuffer(16);
  new DataView(buffer).setBigUint64(0, BigInt(bytes), true);
  return { status: 206, ok: true, arrayBuffer: async () => buffer };
}

describe('GET /api/huggingface/model-memory', () => {
  beforeEach(() => { mockFetch.mockReset(); auth.loggedIn = true; });

  it('refuses anyone not logged in, without fetching anything', async () => {
    auth.loggedIn = false;
    expect((await lookup('org/model')).status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a model id that is not owner/model', async () => {
    expect((await lookup('../../etc')).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not download a header that claims to be gigabytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [{ type: 'file', path: 'model.safetensors' }] })
      .mockResolvedValueOnce(headerClaiming(8 * 1024 ** 3));

    expect((await lookup('attacker/huge-header')).status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
