/**
 * The last raw ingest payload, kept in KV purely so a human can eyeball the
 * most recent upload at /api/last.
 *
 * This is a debug convenience and nothing more. R2 is the archive of record —
 * storeWorkouts writes every workout's raw JSON there — so if KV can't take
 * the snapshot, the right move is to shrug and carry on. It earned its own
 * module the day a 31 MB Health Auto Export backfill blew past KV's 25 MiB
 * per-value cap and the resulting 413 took the whole (otherwise fine) ingest
 * down with it.
 */

/**
 * Snapshot ceiling. Well under KV's own 25 MiB per-value cap: a routine
 * upload is a few hundred KB, while an HAE historical backfill runs to tens of
 * MB, and writing that much on every ingest is a lot of KV traffic to buy an
 * endpoint that gets read once in a blue moon. Past this we keep the meta and
 * skip the body — the full payload is in R2 either way.
 *
 * Deliberately not a truncation: /api/last serves the stored value as
 * application/json, and half a payload is invalid JSON.
 */
export const LAST_PAYLOAD_MAX_BYTES = 1024 * 1024;

export interface LastPayloadUser {
  id: string;
  email: string;
}

export const lastKey = (userId: string) => `last:${userId}`;

/**
 * Best-effort debug snapshot of the last raw payload. Never throws: the
 * caller's real work (R2 + D1) matters, this doesn't.
 *
 * `raw` is spliced in as pre-serialized text rather than re-stringified from
 * the parsed object — for a historical HAE backfill (many workouts, per-second
 * arrays) that second full traversal + in-memory copy is enough on its own to
 * trip Cloudflare's CPU/memory resource limit (error 1102).
 */
export async function putLastPayload(
  kv: KVNamespace,
  user: LastPayloadUser,
  raw: string,
  receivedAt: string,
): Promise<void> {
  // `raw.length` counts UTF-16 code units while KV measures UTF-8 bytes, so
  // this can undercount by up to 3x on non-ASCII input. Harmless here: even
  // the worst case stays an order of magnitude inside KV's real limit, which
  // is the whole point of a cap this conservative. An exact TextEncoder pass
  // would cost another full copy of the payload in memory.
  const oversize = raw.length > LAST_PAYLOAD_MAX_BYTES;
  const meta = JSON.stringify({
    receivedAt,
    user: { id: user.id, email: user.email },
    bytes: raw.length,
    // Say so explicitly, so /api/last can't be misread as "this is what came
    // in" when it's really "the body was too big to keep".
    ...(oversize
      ? {
          payload_omitted: `payload is ~${raw.length} bytes, over the ${LAST_PAYLOAD_MAX_BYTES}-byte snapshot cap; the raw archive is in R2`,
        }
      : {}),
  });

  try {
    await kv.put(lastKey(user.id), oversize ? `{"meta":${meta}}` : `{"meta":${meta},"payload":${raw}}`);
  } catch (e) {
    console.log(
      "LAST_PAYLOAD_PUT_FAILED",
      JSON.stringify({ user: user.email, bytes: raw.length, error: (e as Error).message }),
    );
  }
}
