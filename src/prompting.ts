import { withGatewayRunDefaults } from "./gatewayRunOptions";
import type { DeveloperProfile, Genre, NarrativeOutput } from "./types";

const LYRICS_TIMEOUT_MS = 90 * 1000;
const LYRICS_MODEL = "@cf/zai-org/glm-4.7-flash";
const LYRICS_SYSTEM_PROMPT =
  "You are a savage comedy roast songwriter. Your only job is to write a brutal, hilarious, repo-specific roast of a developer in song form. Output only the lyrics in the required [verse]/[chorus] shape — no preamble, no analysis, no markdown, no emojis, no curly quotes. Use plain ASCII apostrophes. Every single line must land a punchline grounded in real GitHub evidence the user gives you (repo names, star counts, archived/stale repos, commit messages). Never write programming language names (TypeScript, Python, Rust, JavaScript, Go, C++, etc.) — the TTS singer mispronounces them; roast repos, commits, and habits instead. No filler, no abstract metaphors, no \"sky / cry / lie\" cliche rhymes that ignore the data.";

function buildRepoDigest(profile: DeveloperProfile): string {
  return profile.repos
    .slice(0, 6)
    .map((repo) => {
      const desc = repo.description ? ` — ${repo.description}` : "";
      return `${repo.name} (${repo.primaryLanguage}, ${repo.stars}★)${desc}`;
    })
    .join("\n");
}

function ageInDays(iso: string): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)));
}

function buildRoastSignals(profile: DeveloperProfile): string {
  const staleRepos = profile.repos.filter((repo) => ageInDays(repo.updatedAt) > 180).length;
  const archivedRepos = profile.repos.filter((repo) => repo.archived).length;
  const zeroStarRepos = profile.repos.filter((repo) => repo.stars === 0).length;
  const totalStars = profile.repos.reduce((sum, repo) => sum + repo.stars, 0);
  const topLanguage = profile.topLanguages[0] ?? "Unknown";

  return [
    `Scanned repos: ${profile.repos.length}`,
    `Total stars across scanned repos: ${totalStars}`,
    `Repos with 0 stars: ${zeroStarRepos}`,
    `Archived repos: ${archivedRepos}`,
    `Stale repos (>180 days old): ${staleRepos}`,
    `Top language: ${topLanguage}`,
  ].join("\n");
}

function pickSpicyCommitHighlights(profile: DeveloperProfile): string[] {
  const spicyPattern = /\b(wip|fix|temp|quick|hack|final|oops|test|debug|cleanup|todo|typo)\b/i;
  const spicy = profile.commitHighlights.filter((line) => spicyPattern.test(line));
  if (spicy.length > 0) return spicy.slice(0, 5);
  return profile.commitHighlights.slice(0, 5);
}

/** Deterministic songwriting brief from GitHub-derived profile (no LLM). */
export function buildSongBriefFromProfile(profile: DeveloperProfile): NarrativeOutput {
  const topLanguage = profile.topLanguages[0] ?? "JavaScript";
  const repoCallouts = profile.repos.slice(0, 4).map((r) => r.name);

  const highlights =
    profile.commitHighlights.slice(0, 4).join(" · ") || "public commits and steady iteration";

  const developerPersona = `${profile.username} — active builder shipping fast; Top language: ${topLanguage}.`;

  const storyArc = `${profile.username} ships in public: ${highlights}. Repos and languages paint a real maintenance-and-momentum arc.`;

  const repoList = profile.repos
    .slice(0, 3)
    .map((r) => r.name)
    .join(", ");
  const linerNotes =
    repoList.length > 0
      ? `Forged from your public GitHub — notably ${repoList}.`
      : "Forged from your public GitHub activity.";

  return {
    developerPersona,
    storyArc,
    repoCallouts,
    linerNotes,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const asObj = asRecord(part);
      if (!asObj) return "";
      return typeof asObj.text === "string" ? asObj.text : "";
    })
    .join("");
}

/** GLM 4.7 may put chain-of-thought in reasoning fields while content stays null. */
function assistantTextFromMessage(message: Record<string, unknown>): string {
  const fromContent = messageContentToString(message.content).trim();
  if (fromContent) return fromContent;

  for (const key of ["reasoning_content", "reasoning"] as const) {
    const reasoning = message[key];
    if (typeof reasoning !== "string") continue;
    const fromReasoning = extractVerseChorusFromReasoning(reasoning.trim());
    if (fromReasoning.length > 20) return fromReasoning;
  }
  return "";
}

function textFromChoices(choices: unknown): string {
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  if (!message) return "";
  return assistantTextFromMessage(message).trim();
}

function extractTextFromAiResponse(result: unknown): string {
  if (typeof result === "string") return result;
  const topLevel = asRecord(result);
  if (!topLevel) return "";
  if (typeof topLevel.response === "string") return topLevel.response;

  const nestedResult = asRecord(topLevel.result);
  if (nestedResult && typeof nestedResult.response === "string") return nestedResult.response;

  const fromTopChoices = textFromChoices(topLevel.choices);
  if (fromTopChoices) return fromTopChoices;
  return nestedResult ? textFromChoices(nestedResult.choices) : "";
}

/** If the model only emitted lyrics inside a reasoning trace, pull the tagged block. */
function extractVerseChorusFromReasoning(raw: string): string {
  const lower = raw.toLowerCase();
  const start = lower.indexOf("[verse]");
  if (start < 0) return "";

  let body = raw.slice(start).trim();
  const analysisMarkers = /\n(?:\d+\.\s+\*\*|[#]{1,3}\s|Analyze the Request|Rules:)/i;
  const cut = analysisMarkers.exec(body);
  if (cut && cut.index > 40) {
    body = body.slice(0, cut.index).trim();
  }
  return body;
}

function scrubLyricLine(line: string): string {
  return line
    .replace(/^[\s>*-]+/, "")
    .replace(/^\d+[\).\s-]+/, "")
    .replace(/^"(.*)"$/, "$1")
    .trim();
}

function trimToWordLimit(lines: string[], maxWords: number): string[] {
  const words = lines.join(" ").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return lines;
  const clipped = words.slice(0, maxWords).join(" ");
  return clipped
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lines.length);
}

function enforceLyricShape(raw: string, profile: DeveloperProfile, callouts: string[]): string {
  const cleanedLines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const collectSection = (tag: "verse" | "chorus"): string[] => {
    const index = cleanedLines.findIndex((line) => line.toLowerCase() === `[${tag}]`);
    if (index < 0) return [];
    const out: string[] = [];
    for (let i = index + 1; i < cleanedLines.length; i += 1) {
      const line = cleanedLines[i];
      if (/^\[(verse|chorus)\]$/i.test(line)) break;
      if (/^\[.+\]$/.test(line)) continue;
      const scrubbed = scrubLyricLine(line);
      if (scrubbed) out.push(scrubbed);
    }
    return out;
  };

  const fallbackRepo = callouts[0] ?? "side-project";
  const fallbackVerse = [
    `${profile.username}, your commits read like cliffhangers with no finale`,
    `You renamed ${fallbackRepo} three times and called it agile strategy`,
    `Zero-star grindset, shipping bugs at influencer velocity`,
  ];
  const fallbackChorus = [
    `Push, panic, patch, repeat - that's your nightly symphony`,
    `Every "quick fix" turns into a season finale in prod`,
    `${profile.username}, roast-certified by your own commit history`,
  ];

  const genericBody = cleanedLines
    .filter((line) => !/^\[(verse|chorus)\]$/i.test(line))
    .map(scrubLyricLine)
    .filter(Boolean);

  const verseCandidates = collectSection("verse");
  const chorusCandidates = collectSection("chorus");
  const verse = (verseCandidates.length ? verseCandidates : genericBody.slice(0, 3)).slice(0, 3);
  const chorus = (chorusCandidates.length ? chorusCandidates : genericBody.slice(3, 6)).slice(0, 3);

  while (verse.length < 3) verse.push(fallbackVerse[verse.length]);
  while (chorus.length < 3) chorus.push(fallbackChorus[chorus.length]);

  const limited = trimToWordLimit([...verse, ...chorus], 120);
  const limitedVerse = limited.slice(0, 3);
  const limitedChorus = limited.slice(3, 6);
  while (limitedVerse.length < 3) limitedVerse.push(fallbackVerse[limitedVerse.length]);
  while (limitedChorus.length < 3) limitedChorus.push(fallbackChorus[limitedChorus.length]);

  return `[verse]
${limitedVerse[0]}
${limitedVerse[1]}
${limitedVerse[2]}

[chorus]
${limitedChorus[0]}
${limitedChorus[1]}
${limitedChorus[2]}`;
}

function buildLyricsContextBlock(
  profile: DeveloperProfile,
  commitTexture: string[],
): string {
  return `
GitHub-derived context (facts for you; do not paste as bullet labels in lyrics):

Developer: ${profile.username}
Top languages: ${profile.topLanguages.join(", ") || "Unknown"}
Roast signals:
${buildRoastSignals(profile)}

Repos (you may mention real repo names naturally):
${buildRepoDigest(profile)}

Recent commit subjects (texture, not a checklist):
${commitTexture.join("\n") || "(none)"}
`.trim();
}

function buildLyricsPrompt(genre: Genre, contextBlock: string, callouts: string[]): string {
  return `
You're writing a ROAST SONG about the developer below. Be brutal, specific, and funny. Treat this like a stand-up set in song form.

Tone:
- Savage but playful. Land jokes; do not be vague or abstract.
- Punch up the developer's CODE and HABITS, never their identity. No hate speech, slurs, or protected-class attacks.
- Profanity-light: "damn", "hell" ok; avoid f-bombs.
- Use plain ASCII apostrophes (don't, that's), never curly ones.

Genre flavor: ${genre.toLowerCase()} (cadence/feel only — punchlines come first).

${contextBlock}

What makes this a great roast (the bar to clear):
- EVERY line names something concrete: a real repo, a star count, an archived/stale repo, or a real commit phrase. Generic = failure.
- Each line ends in a clear joke or sting — a setup-then-payoff or a brutal observation.
- The [chorus] is the most quotable part: a repeating burn the developer would screenshot.
- Use end rhymes or near-rhymes across the 3 lines of each section. Internal rhyme is a bonus.
- Vary line lengths slightly so it sings; aim for 6-12 words per line.

What to AVOID (these are auto-fails):
- Vague filler like "static in the sky", "floating or dying", "look alive" without context.
- Padding rhymes (lie/sky/cry/why) that don't connect to repo facts.
- Repeating the username more than once total across the whole song.
- Listing repos like a resume — weave them into jokes.
- Any line that could apply to any developer.
- DO NOT use programming language names in the lyrics (no "TypeScript", "Python", "Rust", "JavaScript", "C++", "Go", etc.). The TTS singer mispronounces them. You can imply stack with file extensions only if you must (".ts", ".py") or just describe behavior — but it's safer to skip language names entirely and roast repos, commits, and habits instead.

Required content:
- Mention at least TWO of these exact repo names, naturally inside punchlines: ${callouts.join(", ")}
- Reference at least ONE concrete signal from "Roast signals" (e.g., zero-star count, archived repos, stale repos) — but DO NOT name programming languages.
- If a commit message in the texture block is funny on its own (e.g., "fix typo", "wip", "final final v2"), exploit it.

Required shape (copy this structure exactly — lowercase tags in square brackets):

[verse]
line 1 — sets up a specific repo or habit and burns it
line 2 — escalates with another concrete fact
line 3 — lands a punchline that rhymes/echoes line 1 or 2

[chorus]
line 1 — the quotable hook (the burn they'd repeat)
line 2 — twists or escalates the hook
line 3 — drives it home, rhymes with line 1

Hard rules:
- Tags are literally [verse] and [chorus] on their own lines.
- Exactly 3 lyric lines under [verse] and exactly 3 lyric lines under [chorus].
- Under 120 words total.
- No markdown, no "Verse:" labels, no extra sections, no emojis, no commentary.
- Do not output analysis, safety notes, or instructions.

Mini-example of the QUALITY BAR (FAKE developer "demo-dev" — do NOT reuse these phrases or this name; only mimic the specificity and rhyme density):

[verse]
forty repos, half of them are forks you never touched
"final-final-v2" branch in toy-compiler — bro, that's a clutch
every other PR is just a "fix typo" rush

[chorus]
zero stars, full confidence, that's the demo-dev brand
shipping wip commits like a one-man understaffed band
archived your best idea, then renamed it "grand"

Now write the real lyrics for the developer described above. Output only the song.
`;
}

export async function generateLyrics(
  ai: Ai,
  profile: DeveloperProfile,
  narrative: NarrativeOutput,
  gatewayId: string,
  apiGatewayToken: string | undefined,
  genre: Genre,
): Promise<string> {
  const callouts = narrative.repoCallouts.length
    ? narrative.repoCallouts
    : profile.repos.slice(0, 4).map((repo) => repo.name);
  const commitTexture = pickSpicyCommitHighlights(profile);
  const contextBlock = buildLyricsContextBlock(profile, commitTexture);
  const prompt = buildLyricsPrompt(genre, contextBlock, callouts);

  const raw = await ai.run(
    LYRICS_MODEL,
    {
      messages: [
        { role: "system", content: LYRICS_SYSTEM_PROMPT },
        { role: "user", content: prompt.trim() },
      ],
      temperature: 1,
      max_completion_tokens: 500,
      /** Without this, GLM often fills the budget with reasoning and leaves message.content null. */
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: null,
    },
    withGatewayRunDefaults(gatewayId, apiGatewayToken, LYRICS_TIMEOUT_MS),
  );

  const lyrics = extractTextFromAiResponse(raw).trim();
  if (lyrics.length > 20) {
    return enforceLyricShape(lyrics, profile, callouts);
  }
  return enforceLyricShape("", profile, callouts);
}
