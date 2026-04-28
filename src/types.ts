export type Genre = "Pop" | "Indie Rock" | "Rap" | "Metal" | "Hip Hop" | "Country";

export const SUPPORTED_GENRES: Genre[] = ["Pop", "Indie Rock", "Rap", "Metal", "Hip Hop", "Country"];

export interface GenerateSongRequest {
  username: string;
  genre: Genre;
}

export interface RepoSnapshot {
  name: string;
  description: string;
  stars: number;
  primaryLanguage: string;
  languages: string[];
  updatedAt: string;
  archived: boolean;
}

export interface DeveloperProfile {
  username: string;
  repos: RepoSnapshot[];
  topLanguages: string[];
  languageBreakdown: Record<string, number>;
  commitHighlights: string[];
}

export interface NarrativeOutput {
  developerPersona: string;
  storyArc: string;
  repoCallouts: string[];
  linerNotes: string;
}

export interface SongResult {
  username: string;
  genre: Genre;
  promptSummary: string;
  lyrics: string;
  audioUrl: string;
  linerNotes: string;
  profile: Pick<DeveloperProfile, "topLanguages">;
}

/**
 * Shape stored in KV under the lowercased GitHub handle. Kept compatible with
 * `SongResult` so the share-page can render it through the same client code.
 *
 * Note: `audioUrl` may eventually 404 if the upstream provider rotates signed
 * URLs. Acceptable tradeoff for a simple KV-only cache.
 */
export interface CachedSong {
  username: string;
  genre: Genre;
  lyrics: string;
  audioUrl: string;
  linerNotes: string;
  profile: Pick<DeveloperProfile, "topLanguages">;
  createdAt: string;
}
