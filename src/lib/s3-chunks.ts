// src/lib/s3-chunks.ts — read/write chunk artifacts in S3.
//
// The lazy-hybrid-chunking architecture stores per-chapter chunk JSON in S3
// keyed by the source PDF's sha256. Layout under the source bucket:
//
//   parsed/<pdf_sha256>/
//     ├── metadata.json
//     ├── chapters/
//     │   ├── 00.json
//     │   ├── 01.json
//     │   └── …
//     └── glossary.json
//
// Why under the SOURCE PDF's bucket (not a separate bucket):
//   - Same IAM scope already grants read; only write permission to add.
//   - Same region (no cross-region latency for the eventual generation reads).
//   - Same lifecycle policies; operator manages one bucket.
//   - Multi-user cache key is sha256 — identical PDFs hit the same chunks
//     regardless of who uploaded.
//
// Override path: if CHUNKS_S3_BUCKET env is set, write to that bucket instead.
// Reserved for cases where source-PDF bucket is read-only.
//
// Design anchors:
//   - kb:architecture/discipline/error-handling-discipline §"Pattern 1" — let
//     SDK errors propagate to the outer ingest-worker layer (which has context
//     to update tutorials.status='error'). No retry here.
//   - kb:architecture/crosscut/single-responsibility — this module ONLY does
//     S3 I/O for chunk artifacts. Chunker logic lives in chunker.ts; classifier
//     logic in classifier.ts.

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { s3Env } from './env';
import { parseS3Url } from './s3';
import type { SourceParagraph } from './types';
import type { OutlineClassification } from './ingest/classifier';

// ───────────────────────────────────────────────────────────────────────────
// On-disk types — what we put in S3
// ───────────────────────────────────────────────────────────────────────────

/**
 * One chunk file (chapters/NN.json). Self-contained: holds the title +
 * paragraphs + provenance the generator needs without any DB round-trip.
 */
export interface ChunkArtifact {
  /** Schema version of this artifact shape; bump on breaking layout change. */
  schemaVersion: 1;
  /** 0-based chunk index, matches chapters.ordinal. */
  idx: number;
  /** Display title (from the outline entry that became this chunk). */
  title: string;
  /** Classification (body/appendix; glossary/skipped don't get a chunk artifact). */
  classification: Extract<OutlineClassification, 'body' | 'appendix'>;
  pageStart: number;
  pageEnd: number;
  /** Outline depth at which this chunk was emitted. */
  depth: number;
  /** Parent chunk idx in the outline tree, or null for top-level chunks. */
  parentIdx: number | null;
  /** The paragraph payload for the generator. */
  paragraphs: SourceParagraph[];
}

/**
 * Top-level metadata.json for the whole parsed PDF. Holds the chunk index
 * (for navigation), the skipped sections (for audit), the glossary count,
 * and provenance fields used for cache invalidation.
 */
export interface MetadataArtifact {
  schemaVersion: 1;
  pdfSha256: string;
  parsedAt: string;
  pageCount: number;
  outlinePresent: boolean;
  chunkerVersion: number;
  classificationVersion: number;
  chunks: Array<{
    idx: number;
    title: string;
    classification: 'body' | 'appendix';
    pageStart: number;
    pageEnd: number;
    paragraphCount: number;
    depth: number;
    parentIdx: number | null;
    s3Key: string;
  }>;
  skipped: Array<{
    title: string;
    classification: 'front-matter' | 'bibliography' | 'glossary' | 'index';
    pageStart: number;
    pageEnd: number;
  }>;
  glossaryAvailable: boolean;
}

/**
 * glossary.json shape. One entry per term extracted from glossary-classified
 * outline entries. v1 ships empty array when no glossary section detected.
 */
export interface GlossaryArtifact {
  schemaVersion: 1;
  terms: Array<{
    term: string;
    definition: string;
    sourceParagraphRef: string;
  }>;
}

// ───────────────────────────────────────────────────────────────────────────
// Path helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical S3 prefix for a parsed PDF.
 * Returns just the prefix (without trailing slash):  `parsed/<sha256>`
 */
export function chunksPrefix(pdfSha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(pdfSha256)) {
    throw new Error(`chunksPrefix: invalid sha256 ${JSON.stringify(pdfSha256)}`);
  }
  return `parsed/${pdfSha256.toLowerCase()}`;
}

export function metadataKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/metadata.json`;
}

export function chapterKey(pdfSha256: string, idx: number): string {
  if (!Number.isInteger(idx) || idx < 0) {
    throw new Error(`chapterKey: idx must be non-negative integer, got ${idx}`);
  }
  return `${chunksPrefix(pdfSha256)}/chapters/${String(idx).padStart(2, '0')}.json`;
}

export function glossaryKey(pdfSha256: string): string {
  return `${chunksPrefix(pdfSha256)}/glossary.json`;
}

// ───────────────────────────────────────────────────────────────────────────
// Client construction (mirrors src/lib/s3.ts pattern)
// ───────────────────────────────────────────────────────────────────────────

function buildClient() {
  const cfg = s3Env();
  return new S3Client({
    region: cfg.AWS_REGION,
    credentials: {
      accessKeyId: cfg.AWS_ACCESS_KEY_ID,
      secretAccessKey: cfg.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Resolve the bucket name to write chunks into. Defaults to extracting the
 * bucket from the source PDF's s3:// URL (so chunks live next to the source).
 * Override via env CHUNKS_S3_BUCKET when source bucket is read-only.
 */
export function resolveChunksBucket(sourcePdfS3Url: string): string {
  const override = process.env.CHUNKS_S3_BUCKET;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return parseS3Url(sourcePdfS3Url).bucket;
}

// ───────────────────────────────────────────────────────────────────────────
// Write helpers
// ───────────────────────────────────────────────────────────────────────────

export class S3ChunkWriteError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
    public override readonly cause?: unknown,
  ) {
    super(`s3 chunk write failed: ${message} (bucket=${bucket}, key=${key})`);
    this.name = 'S3ChunkWriteError';
  }
}

async function putJson(bucket: string, key: string, body: unknown): Promise<void> {
  const client = buildClient();
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
        // ServerSideEncryption omitted — relies on bucket default if any.
      }),
    );
  } catch (err) {
    throw new S3ChunkWriteError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
}

export async function writeChunk(
  bucket: string,
  pdfSha256: string,
  chunk: ChunkArtifact,
): Promise<{ s3Key: string }> {
  const key = chapterKey(pdfSha256, chunk.idx);
  await putJson(bucket, key, chunk);
  return { s3Key: key };
}

export async function writeMetadata(
  bucket: string,
  pdfSha256: string,
  metadata: MetadataArtifact,
): Promise<{ s3Key: string }> {
  const key = metadataKey(pdfSha256);
  await putJson(bucket, key, metadata);
  return { s3Key: key };
}

export async function writeGlossary(
  bucket: string,
  pdfSha256: string,
  glossary: GlossaryArtifact,
): Promise<{ s3Key: string }> {
  const key = glossaryKey(pdfSha256);
  await putJson(bucket, key, glossary);
  return { s3Key: key };
}

// ───────────────────────────────────────────────────────────────────────────
// Read helpers — multi-user cache hit path
// ───────────────────────────────────────────────────────────────────────────

export class S3ChunkReadError extends Error {
  constructor(
    message: string,
    public readonly bucket: string,
    public readonly key: string,
    public override readonly cause?: unknown,
  ) {
    super(`s3 chunk read failed: ${message} (bucket=${bucket}, key=${key})`);
    this.name = 'S3ChunkReadError';
  }
}

/**
 * Returns true if the object exists. Used to skip re-parsing on cache hits.
 *
 * AWS quirk: a HEAD on a missing object returns 404 ("NotFound") when the
 * caller has `s3:ListBucket` permission; without it, S3 returns **403**
 * (Forbidden) to obscure object existence. We can't distinguish "missing
 * object, no ListBucket" from "object exists, no GetObject" — both look
 * like a 403 with no specific error code.
 *
 * Resolution policy:
 *   - 404 / NotFound / NoSuchKey → cache miss (object doesn't exist)
 *   - 403 (without specific code) → ALSO treat as cache miss. Safe because:
 *       (a) if the object actually exists, the subsequent PUT will overwrite
 *           it (idempotent — chunks are content-addressed by sha256)
 *       (b) if the object doesn't exist, we correctly proceed to write
 *       (c) if PUT is also denied, the user gets a clear PutObject 403
 *   - any other error → re-raise (real failure: throttle, network, etc.)
 *
 * The full IAM grant that avoids the 403-ambiguity is documented in
 * .env.example (s3:ListBucket on the bucket + GetObject/PutObject on /parsed/*).
 */
export async function chunksExist(bucket: string, pdfSha256: string): Promise<boolean> {
  const client = buildClient();
  const key = metadataKey(pdfSha256);
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const code = e.name;
    if (code === 'NotFound' || code === 'NoSuchKey') return false;
    const status = e.$metadata?.httpStatusCode;
    if (status === 403 || status === 404) {
      // Ambiguous 403 (or rare 404 without specific name). Per the policy
      // above: treat as cache miss + log so operators can spot the
      // permission gap when latency or write-overhead matters.
      // eslint-disable-next-line no-console
      console.warn(
        `[s3-chunks] HEAD ${key} returned ${status}; treating as cache miss. ` +
          `Grant s3:ListBucket to enable cleaner cache-hit semantics.`,
      );
      return false;
    }
    // Other errors (network, throttle, real auth failure): re-raise.
    throw new S3ChunkReadError(`HEAD failed: ${(err as Error).message}`, bucket, key, err);
  }
}

async function getJson<T>(bucket: string, key: string): Promise<T> {
  const client = buildClient();
  let resp;
  try {
    resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    throw new S3ChunkReadError(`sdk send failed: ${(err as Error).message}`, bucket, key, err);
  }
  if (!resp.Body) throw new S3ChunkReadError('response body empty', bucket, key);
  const text = await streamToString(resp.Body as Readable);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new S3ChunkReadError(
      `json parse failed: ${(err as Error).message}`,
      bucket,
      key,
      err,
    );
  }
}

export async function readMetadata(
  bucket: string,
  pdfSha256: string,
): Promise<MetadataArtifact> {
  return getJson<MetadataArtifact>(bucket, metadataKey(pdfSha256));
}

export async function readChunk(
  bucket: string,
  pdfSha256: string,
  idx: number,
): Promise<ChunkArtifact> {
  return getJson<ChunkArtifact>(bucket, chapterKey(pdfSha256, idx));
}

export async function readGlossary(
  bucket: string,
  pdfSha256: string,
): Promise<GlossaryArtifact> {
  return getJson<GlossaryArtifact>(bucket, glossaryKey(pdfSha256));
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (file-private)
// ───────────────────────────────────────────────────────────────────────────

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunkRaw of stream) {
    const chunk = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
