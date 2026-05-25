/**
 * src/lib/eval/persona.ts — persona registry + LLM rating invocation.
 *
 * A persona is a markdown file at `docs/eval/personas/<slug>.md` with YAML
 * front-matter (slug, display_name, model, description) and a freeform body
 * (Who you are / What you care about / Red flags / Green flags / Judgment
 * criterion / Honesty constraint). The harness reads the file verbatim and
 * inlines the body into a system prompt — there is no template substitution
 * beyond a small set of bracketed variables the persona body MAY include.
 *
 * Per design D1 (docs/eval/HARNESS-DESIGN.md §Decisions), adding a new
 * persona is a single-file drop. This module does NOT enumerate personas
 * at import time — it resolves them by slug at call time.
 *
 * Per the explicit constraint in the task brief: the OpenAI client is
 * imported but NEVER called in tests. Tests pass a mock client. Real
 * harness runs use the production singleton from `@/lib/openai/client`.
 *
 * Design contract: HARNESS-DESIGN.md §"Persona registry" + §Rubric
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  RUBRIC_JSON_SCHEMA,
  parseRubricResponse,
  type RubricResponse,
} from './rubric';

// ─────────────────────────────────────────────────────────────────────────────
// Persona file format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Front-matter shape parsed from the `--- ... ---` block at the top of a
 * persona markdown file. We use a minimal hand-rolled parser rather than
 * pulling in a YAML library: the front-matter is intentionally trivial,
 * and we'd rather fail loudly on anything fancier than add a dependency.
 */
export interface PersonaFrontMatter {
  slug: string;
  display_name: string;
  model: string;
  description: string;
}

export interface Persona {
  slug: string;
  displayName: string;
  model: string;
  description: string;
  /** The raw markdown body (everything AFTER the closing `---` of front-matter). */
  body: string;
  /** Absolute path the persona was loaded from. Useful for diagnostics. */
  sourcePath: string;
}

const PERSONA_DIR_DEFAULT = 'docs/eval/personas';

/**
 * Load one persona by slug. Searches `<repoRoot>/<personaDir>/<slug>.md`.
 * Throws if the file is missing or the front-matter is malformed — we'd
 * rather fail loudly here than ship a half-loaded persona into the LLM.
 */
export function loadPersona(
  slug: string,
  repoRoot: string,
  personaDir: string = PERSONA_DIR_DEFAULT,
): Persona {
  if (!/^[a-z0-9_-]+$/.test(slug)) {
    throw new Error(
      `persona slug "${slug}" is not safe; expected lowercase alphanumeric + - _`,
    );
  }

  const absPath = path.resolve(repoRoot, personaDir, `${slug}.md`);
  if (!fs.existsSync(absPath)) {
    throw new Error(`persona file not found: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf8');
  const { frontMatter, body } = parsePersonaFile(raw, absPath);

  if (frontMatter.slug !== slug) {
    throw new Error(
      `persona file ${absPath}: front-matter slug "${frontMatter.slug}" does not match filename slug "${slug}"`,
    );
  }

  return {
    slug: frontMatter.slug,
    displayName: frontMatter.display_name,
    model: frontMatter.model,
    description: frontMatter.description,
    body,
    sourcePath: absPath,
  };
}

/**
 * Parse a persona markdown file into front-matter + body. Front-matter
 * is the `---\n...\n---\n` block at the top. We accept only a tiny YAML
 * dialect: key-value pairs with `key: value`, plus block scalars via
 * `key: |`. No nested objects, no lists.
 */
export function parsePersonaFile(
  raw: string,
  sourcePathForErrors: string,
): { frontMatter: PersonaFrontMatter; body: string } {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(
      `persona file ${sourcePathForErrors}: missing or malformed front-matter (expected \`---\\n...\\n---\\n\` at top)`,
    );
  }

  const fmRaw = fmMatch[1];
  const body = fmMatch[2];

  const fm: Record<string, string> = {};
  const lines = fmRaw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const blockMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*\|\s*$/);
    if (blockMatch) {
      const key = blockMatch[1];
      const chunks: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        chunks.push(lines[i].replace(/^ {0,2}/, ''));
        i++;
      }
      fm[key] = chunks.join('\n').trim();
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (kvMatch) {
      fm[kvMatch[1]] = kvMatch[2].trim();
      i++;
      continue;
    }
    // Unknown line — fail loud rather than silently drop.
    throw new Error(
      `persona file ${sourcePathForErrors}: cannot parse front-matter line ${i + 1}: ${JSON.stringify(line)}`,
    );
  }

  for (const required of ['slug', 'display_name', 'model', 'description'] as const) {
    if (!fm[required]) {
      throw new Error(
        `persona file ${sourcePathForErrors}: front-matter missing required key "${required}"`,
      );
    }
  }

  return {
    frontMatter: {
      slug: fm.slug,
      display_name: fm.display_name,
      model: fm.model,
      description: fm.description,
    },
    body: body.trim(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt building
// ─────────────────────────────────────────────────────────────────────────────

export interface RatingRequest {
  persona: Persona;
  variantName: string;
  chapterOrdinal: number;
  chapterTitle: string;
  /** The narrative-only markdown body for the chapter under evaluation. */
  narrativeMarkdown: string;
  /**
   * Optional: peer variants the persona is told exist. Surfaces the A/B
   * framing in the prompt without leaking the OTHER narratives.
   */
  peerVariantNames?: string[];
}

/**
 * Build the messages array we'll pass to `openai.chat.completions.create`.
 * The system prompt is the persona body verbatim + the load-bearing
 * "you MUST emit JSON matching this schema" closer. The user prompt is
 * the chapter narrative with a small header that names the variant.
 *
 * Why the persona body is inlined verbatim rather than templated: the
 * persona file is the source of truth. Template substitution introduces
 * a second layer where bugs can hide; inlining keeps the contract
 * legible (what the persona file says is exactly what the LLM sees).
 */
export function buildRatingMessages(req: RatingRequest): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  const system = [
    req.persona.body,
    '',
    '## Output contract (load-bearing)',
    '',
    'You will emit a SINGLE JSON object matching the rubric schema. Do not',
    'wrap it in markdown. Do not include commentary outside the JSON.',
    '',
    'For PHASE 1 (this run), the dimensions `ux_clarity` and',
    '`navigation_friction` MUST be `null` — you have only the narrative',
    'markdown, not the live UI. Fill the other four dimensions with',
    'integers 1-10 per the rubric scale anchors.',
    '',
    '`evidence.phrase_that_landed` and `evidence.phrase_that_failed` MUST',
    'be verbatim quotes from the narrative (or `""` if nothing failed).',
    '`named_anchors_present` and `named_anchors_missing` are arrays of',
    'canonical terms or specific incidents you expected to see in this',
    'chapter, listing which ones survived versus which ones are absent.',
  ].join('\n');

  const peerNote =
    req.peerVariantNames && req.peerVariantNames.length > 0
      ? `\n\nThis run also includes peer variants: ${req.peerVariantNames.join(', ')}. ` +
        `You are NOT rating them now — focus only on variant "${req.variantName}" below.`
      : '';

  const user = [
    `# Variant under evaluation: ${req.variantName}`,
    `# Chapter ${req.chapterOrdinal}: ${req.chapterTitle}`,
    peerNote,
    '',
    '---',
    '',
    req.narrativeMarkdown,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM invocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal contract a chat-completions client must satisfy for the rater.
 * Matches the shape of `openai.chat.completions` so production wiring
 * stays trivial; tests pass a hand-rolled mock that satisfies this
 * interface without touching the SDK.
 */
export interface RatingChatClient {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
        response_format: {
          type: 'json_schema';
          json_schema: typeof RUBRIC_JSON_SCHEMA;
        };
        temperature?: number;
      }) => Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

export interface RatingResult {
  variantName: string;
  chapterOrdinal: number;
  personaSlug: string;
  runIdx: number;
  response: RubricResponse;
}

/**
 * Call the LLM once with the persona prompt and parse the response.
 * Throws on any failure (network, schema, word-cap) — the runner's
 * job is to decide whether to retry or skip; this function stays pure.
 *
 * `temperature` defaults to 0.2 — low enough that runs are reproducible,
 * non-zero so the per-run variance D2 averages over is real.
 */
export async function rateChapter(
  req: RatingRequest,
  client: RatingChatClient,
  runIdx = 0,
  temperature = 0.2,
): Promise<RatingResult> {
  const messages = buildRatingMessages(req);
  const completion = await client.chat.completions.create({
    model: req.persona.model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: RUBRIC_JSON_SCHEMA,
    },
    temperature,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      `persona ${req.persona.slug}: empty response for variant=${req.variantName} ch=${req.chapterOrdinal}`,
    );
  }

  const response = parseRubricResponse(content);
  return {
    variantName: req.variantName,
    chapterOrdinal: req.chapterOrdinal,
    personaSlug: req.persona.slug,
    runIdx,
    response,
  };
}
