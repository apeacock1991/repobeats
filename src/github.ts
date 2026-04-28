import type { DeveloperProfile, RepoSnapshot } from "./types";

const GITHUB_API_BASE = "https://api.github.com";
const MAX_REPOS = 6;
const MAX_COMMITS_PER_REPO = 4;

interface GithubRepo {
  name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  archived: boolean;
  updated_at: string;
  fork: boolean;
}

interface GithubCommit {
  commit?: {
    message?: string;
  };
}

function createGithubHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repobeats-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGithubJSON<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, { headers: createGithubHeaders(token) });
  if (!response.ok) {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const reset = response.headers.get("X-RateLimit-Reset");
    let detail = "";
    if (remaining !== null) {
      detail += ` (rate limit remaining: ${remaining}`;
      if (reset) {
        const resetSec = Number(reset);
        if (!Number.isNaN(resetSec)) {
          detail += `, resets ${new Date(resetSec * 1000).toISOString()}`;
        }
      }
      detail += ")";
    }
    const text = await response.text();
    try {
      const errBody = JSON.parse(text) as { message?: string };
      if (typeof errBody.message === "string") {
        detail += ` — ${errBody.message}`;
      }
    } catch {
      if (text.length > 0 && text.length < 400) {
        detail += ` — ${text}`;
      }
    }
    throw new Error(`GitHub request failed (${response.status})${detail}`);
  }
  return (await response.json()) as T;
}

function pickRelevantRepos(repos: GithubRepo[]): GithubRepo[] {
  const candidates = repos.filter((repo) => !repo.fork);
  if (!candidates.length) return [];

  const byRecent = [...candidates]
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, 4);

  const recentNames = new Set(byRecent.map((repo) => repo.name.toLowerCase()));
  const byStars = [...candidates]
    .filter((repo) => !recentNames.has(repo.name.toLowerCase()))
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 3);

  const combined = [...byRecent, ...byStars];
  if (combined.length < MAX_REPOS) {
    const chosen = new Set(combined.map((repo) => repo.name.toLowerCase()));
    for (const repo of candidates) {
      if (chosen.has(repo.name.toLowerCase())) continue;
      combined.push(repo);
      chosen.add(repo.name.toLowerCase());
      if (combined.length >= MAX_REPOS) break;
    }
  }

  return combined
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, MAX_REPOS);
}

function normalizeCommitHighlights(messages: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const rawMessage of messages) {
    const message = rawMessage.replace(/\s+/g, " ").trim();
    if (!message) continue;
    const key = message.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(message);
  }

  return cleaned;
}

export async function buildDeveloperProfile(username: string, githubToken?: string): Promise<DeveloperProfile> {
  const repoUrl = `${GITHUB_API_BASE}/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`;
  const repos = await fetchGithubJSON<GithubRepo[]>(repoUrl, githubToken);

  if (!repos.length) {
    throw new Error("No public repositories found for this user.");
  }

  const selectedRepos = pickRelevantRepos(repos);
  const languageBreakdown: Record<string, number> = {};
  const repoSnapshots: RepoSnapshot[] = [];
  const commitHighlights: string[] = [];

  await Promise.all(
    selectedRepos.map(async (repo) => {
      const repoLanguagesUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/languages`;
      let languages: string[] = [];
      try {
        const languageMap = await fetchGithubJSON<Record<string, number>>(repoLanguagesUrl, githubToken);
        languages = Object.keys(languageMap).slice(0, 4);
        for (const [language, bytes] of Object.entries(languageMap)) {
          languageBreakdown[language] = (languageBreakdown[language] ?? 0) + bytes;
        }
      } catch {
        if (repo.language) {
          languages = [repo.language];
          languageBreakdown[repo.language] = (languageBreakdown[repo.language] ?? 0) + 1;
        }
      }

      repoSnapshots.push({
        name: repo.name,
        description: repo.description ?? "",
        stars: repo.stargazers_count,
        primaryLanguage: repo.language ?? languages[0] ?? "Unknown",
        languages,
        updatedAt: repo.updated_at,
        archived: repo.archived,
      });

      const commitsUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(username)}/${encodeURIComponent(repo.name)}/commits?per_page=${MAX_COMMITS_PER_REPO}`;
      try {
        const commits = await fetchGithubJSON<GithubCommit[]>(commitsUrl, githubToken);
        for (const commit of commits) {
          const message = commit.commit?.message?.split("\n")[0]?.trim();
          if (message) {
            commitHighlights.push(message.slice(0, 120));
          }
        }
      } catch {
        // Skip commit highlights gracefully when repo history is unavailable or rate-limited.
      }
    }),
  );

  const topLanguages = Object.entries(languageBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([language]) => language);

  return {
    username,
    repos: repoSnapshots
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, MAX_REPOS),
    topLanguages,
    languageBreakdown,
    commitHighlights: normalizeCommitHighlights(commitHighlights).slice(0, 12),
  };
}
