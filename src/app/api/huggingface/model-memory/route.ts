import { NextRequest, NextResponse } from "next/server";
import { getModelMemory, type HfMemResult } from "@/lib/hf-mem";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { rateLimit } from "@/lib/ratelimit";

// Cache for memory results (in-memory, resets on server restart)
const memoryCache = new Map<string, { data: HfMemResult; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_MAX_ENTRIES = 1000;
const MODEL_ID = /^[\w.-]+\/[\w.-]+$/;
const REVISION = /^[\w.-]{1,100}$/;

// Each lookup makes the server fetch from Hugging Face, so it is for logged-in customers, rate limited.
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedCustomer(request);
  if (auth instanceof NextResponse) return auth;
  if (!rateLimit(`model-memory:${auth.accountId}`, { maxRequests: 30, windowMs: 60_000 }).success) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }

  const searchParams = request.nextUrl.searchParams;
  const modelId = searchParams.get("modelId");
  const revision = searchParams.get("revision") || "main";

  if (!modelId || !MODEL_ID.test(modelId) || !REVISION.test(revision)) {
    return NextResponse.json(
      { error: "modelId must look like owner/model" },
      { status: 400 }
    );
  }

  // Check cache first
  const cacheKey = `${modelId}:${revision}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return NextResponse.json({
      success: true,
      data: cached.data,
      cached: true,
    });
  }

  try {
    const result = await getModelMemory(modelId, revision);

    if (!result) {
      return NextResponse.json(
        { error: "Could not fetch memory information for this model" },
        { status: 404 }
      );
    }

    // Cache the result, dropping the oldest entry once the cache is full
    if (memoryCache.size >= CACHE_MAX_ENTRIES) memoryCache.delete(memoryCache.keys().next().value!);
    memoryCache.set(cacheKey, { data: result, timestamp: Date.now() });

    return NextResponse.json({
      success: true,
      data: result,
      cached: false,
    });
  } catch (error) {
    console.error("Error fetching model memory:", error);
    return NextResponse.json(
      { error: "Failed to fetch memory information" },
      { status: 500 }
    );
  }
}
