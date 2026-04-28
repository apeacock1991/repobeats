import { getErrorMessage } from "./errorUtils";
import { withGatewayRunDefaults } from "./gatewayRunOptions";
import type { DeveloperProfile, GenerateSongRequest, NarrativeOutput } from "./types";

/** Cap MiniMax generation at 90s to avoid 60s gateway defaults. */
const ATTEMPT_TIMEOUT_MS = 90 * 1000;

function extractAudioUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { audio?: unknown; result?: { audio?: unknown } };
  if (typeof v.audio === "string" && v.audio.length > 0) return v.audio;
  if (v.result && typeof v.result === "object" && typeof v.result.audio === "string" && v.result.audio.length > 0) {
    return v.result.audio;
  }
  return undefined;
}

function snippet(value: unknown): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > 400 ? `${str.slice(0, 400)}…` : str;
  } catch {
    return String(value).slice(0, 400);
  }
}

export async function generateSongAudio(
  ai: Ai,
  gatewayId: string,
  apiGatewayToken: string | undefined,
  payload: GenerateSongRequest,
  _profile: DeveloperProfile,
  _narrative: NarrativeOutput,
  lyrics: string,
): Promise<string> {
  const genreLower = payload.genre.toLowerCase();
  const musicPrompt = `${genreLower} song, funny and tongue-in-cheek roast energy`;
  const lyricsTrimmed = lyrics.trim();
  const hasLyrics = lyricsTrimmed.length > 0;

  const input: Record<string, unknown> = {
    prompt: musicPrompt.slice(0, 2000),
    is_instrumental: false,
    format: "mp3",
    lyrics_optimizer: !hasLyrics,
  };

  if (hasLyrics) {
    /** Keep MiniMax input short — long lyrics slow generation. GLM should comply; this caps overflow. */
    input.lyrics = lyricsTrimmed.slice(0, 1100);
  }

  const cacheKey = crypto.randomUUID();

  let result: unknown;
  try {
    result = await ai.run(
      "minimax/music-2.6",
      input,
      withGatewayRunDefaults(gatewayId, apiGatewayToken, ATTEMPT_TIMEOUT_MS, {
        gateway: {
          id: gatewayId,
          cacheKey,
          cacheTtl: 86400,
        },
      }),
    );
  } catch (err) {
    const msg = getErrorMessage(err, "AI run failed");
    throw new Error(`MiniMax music generation failed: ${msg}`);
  }

  const audio = extractAudioUrl(result);
  if (typeof audio === "string" && (audio.startsWith("http://") || audio.startsWith("https://"))) {
    return audio;
  }

  throw new Error(
    `Music model did not return a usable audio URL. Response snippet: ${snippet(result)}`,
  );
}
