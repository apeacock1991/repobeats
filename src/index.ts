import { buildDeveloperProfile } from "./github";
import { getErrorMessage } from "./errorUtils";
import { generateSongAudio } from "./music";
import { buildSongBriefFromProfile, generateLyrics } from "./prompting";
import {
  SUPPORTED_GENRES,
  type CachedSong,
  type GenerateSongRequest,
  type SongResult,
} from "./types";

/** Lowercased GitHub handle is the canonical KV key. */
function songKey(username: string): string {
  return `song:${username.toLowerCase()}`;
}

/** GitHub handle rules: alphanumeric and hyphens, no leading/trailing/double hyphens, 1-39 chars. */
const HANDLE_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/**
 * KV TTL for cached songs. Matches MiniMax's audio URL lifetime so we never
 * serve a stale share link that 404s on the audio.
 */
const CACHE_TTL_SECONDS = 24 * 60 * 60;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requestIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isGenre(value: unknown): value is GenerateSongRequest["genre"] {
  return typeof value === "string" && SUPPORTED_GENRES.includes(value as GenerateSongRequest["genre"]);
}

function isTopLanguagesProfile(value: unknown): value is CachedSong["profile"] {
  if (!isRecord(value)) return false;
  const topLanguages = value.topLanguages;
  return Array.isArray(topLanguages) && topLanguages.every((entry) => typeof entry === "string");
}

function isCachedSong(value: unknown): value is CachedSong {
  if (!isRecord(value)) return false;
  return (
    typeof value.username === "string" &&
    isGenre(value.genre) &&
    typeof value.lyrics === "string" &&
    typeof value.audioUrl === "string" &&
    typeof value.linerNotes === "string" &&
    typeof value.createdAt === "string" &&
    isTopLanguagesProfile(value.profile)
  );
}

function parseCachedSong(raw: string): CachedSong | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedSong(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toSongResult(cached: CachedSong, promptSummary: string): SongResult {
  return {
    username: cached.username,
    genre: cached.genre,
    promptSummary,
    lyrics: cached.lyrics,
    audioUrl: cached.audioUrl,
    linerNotes: cached.linerNotes,
    profile: cached.profile,
  };
}

function buildCachedSong(
  payload: GenerateSongRequest,
  lyrics: string,
  audioUrl: string,
  linerNotes: string,
  topLanguages: string[],
): CachedSong {
  return {
    username: payload.username,
    genre: payload.genre,
    lyrics,
    audioUrl,
    linerNotes,
    profile: { topLanguages },
    createdAt: new Date().toISOString(),
  };
}

function parseRequestJson(request: Request): Promise<unknown> {
  return request.json();
}

async function readCachedSong(env: Env, username: string): Promise<CachedSong | undefined> {
  if (!env.SONGS) return undefined;
  try {
    const cachedRaw = await env.SONGS.get(songKey(username));
    if (!cachedRaw) return undefined;
    const cached = parseCachedSong(cachedRaw);
    if (!cached) return undefined;
    return cached;
  } catch {
    return undefined;
  }
}

async function runGenerationPipeline(
  env: Env,
  payload: GenerateSongRequest,
  gatewayId: string,
  apiGatewayToken: string | undefined,
): Promise<{ response: SongResult; cached: CachedSong }> {
  const githubToken = env.GH_TOKEN?.trim() || undefined;
  const profile = await buildDeveloperProfile(payload.username, githubToken);

  const narrative = buildSongBriefFromProfile(profile);
  const lyrics = await generateLyrics(env.AI, profile, narrative, gatewayId, apiGatewayToken, payload.genre);
  const audioUrl = await generateSongAudio(env.AI, gatewayId, apiGatewayToken, payload, profile, narrative, lyrics);

  const response: SongResult = {
    username: payload.username,
    genre: payload.genre,
    promptSummary: narrative.storyArc,
    lyrics,
    audioUrl,
    linerNotes: narrative.linerNotes,
    profile: {
      topLanguages: profile.topLanguages,
    },
  };
  const cached = buildCachedSong(payload, lyrics, audioUrl, narrative.linerNotes, profile.topLanguages);
  return { response, cached };
}

function persistCachedSong(env: Env, ctx: ExecutionContext, username: string, cached: CachedSong): void {
  if (!env.SONGS) return;
  /**
   * Persist to KV after we've responded so we don't add KV write latency
   * to a request that already took ~60s. Last write wins per username, which
   * is what we want — sharing /@handle should show the most recent song.
   */
  ctx.waitUntil(
    env.SONGS
      .put(songKey(username), JSON.stringify(cached), {
        expirationTtl: CACHE_TTL_SECONDS,
      })
      .catch(() => {}),
  );
}

function validatePayload(raw: unknown): { valid: true; payload: GenerateSongRequest } | { valid: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "Body must be valid JSON." };
  }

  const body = raw as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username.trim() : "";

  if (!HANDLE_RE.test(username)) {
    return { valid: false, error: "Please provide a valid GitHub username." };
  }

  const rawGenre = typeof body.genre === "string" ? body.genre.trim() : "";
  const genre = SUPPORTED_GENRES.find((g) => g.toLowerCase() === rawGenre.toLowerCase());
  if (!genre) {
    return { valid: false, error: `Genre must be one of: ${SUPPORTED_GENRES.join(", ")}.` };
  }

  return {
    valid: true,
    payload: {
      username,
      genre,
    },
  };
}

async function handleGenerateSong(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown;
  try {
    body = await parseRequestJson(request);
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON.", code: "INVALID_JSON" }, 400);
  }

  const validation = validatePayload(body);
  if (!validation.valid) {
    return jsonResponse({ error: validation.error, code: "INVALID_INPUT" }, 400);
  }

  /**
   * If we already have a cached song for this user (within the 24h TTL),
   * return it instead of regenerating. Cache hits skip the rate limiter
   * entirely — we only want to throttle expensive AI generation, not lookups.
   */
  const cachedSong = await readCachedSong(env, validation.payload.username);
  if (cachedSong) {
    return jsonResponse(toSongResult(cachedSong, ""));
  }

  /** Cache miss → real generation, so this counts against the per-IP rate limit. */
  const ip = requestIp(request);
  if (env.GENERATE_LIMITER) {
    const { success } = await env.GENERATE_LIMITER.limit({ key: ip });
    if (!success) {
      return jsonResponse(
        {
          error: "Slow down — only one song every 60 seconds. Try again in a moment.",
          code: "RATE_LIMITED",
        },
        429,
      );
    }
  }

  try {
    const gatewayId = env.AI_GATEWAY_ID?.trim();
    if (!gatewayId) {
      return jsonResponse(
        {
          error:
            "AI_GATEWAY_ID is not configured. Set it to your AI Gateway name (for example default or minimax-test) in wrangler vars or secrets.",
          code: "MISSING_AI_GATEWAY",
        },
        500,
      );
    }

    const apiGatewayToken = env.API_GW_TOKEN?.trim();

    const payload = validation.payload;
    const { response, cached } = await runGenerationPipeline(env, payload, gatewayId, apiGatewayToken);
    persistCachedSong(env, ctx, payload.username, cached);
    return jsonResponse(response);
  } catch (error) {
    return jsonResponse(
      {
        error: getErrorMessage(error),
        code: "GENERATION_FAILED",
      },
      500,
    );
  }
}

async function handleSongLookup(handle: string, env: Env): Promise<Response> {
  if (!HANDLE_RE.test(handle)) {
    return jsonResponse({ error: "Invalid handle.", code: "INVALID_HANDLE" }, 400);
  }
  if (!env.SONGS) {
    return jsonResponse({ error: "Song cache not configured.", code: "KV_UNCONFIGURED" }, 500);
  }
  const raw = await env.SONGS.get(songKey(handle));
  if (!raw) {
    return jsonResponse({ error: "No song yet for this user.", code: "NOT_FOUND" }, 404);
  }
  const parsed = parseCachedSong(raw);
  if (!parsed) return jsonResponse({ error: "Cached song is corrupt.", code: "CACHE_CORRUPT" }, 500);
  return jsonResponse(parsed);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ ok: true, service: "repobeats", timestamp: new Date().toISOString() });
    }

    if (request.method === "POST" && url.pathname === "/api/generate-song") {
      return handleGenerateSong(request, env, ctx);
    }

    const songMatch = /^\/api\/song\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && songMatch) {
      return handleSongLookup(decodeURIComponent(songMatch[1]), env);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found", code: "NOT_FOUND" }, 404);
    }

    /**
     * Non-API routes are handled by the assets layer (configured with
     * `not_found_handling: "single-page-application"` so unmatched paths like
     * `/@octocat` serve `index.html`, which then routes client-side).
     */
    return env.ASSETS.fetch(request);
  },
};
