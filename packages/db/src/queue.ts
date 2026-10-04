import { Prisma as PrismaNS } from "../prisma/generated/client.js";
import type { PrismaClient } from "../prisma/generated/client.js";

/** Prisma's error code for a serializable transaction that lost its race. */
const SERIALIZATION_FAILURE = "P2034";

export interface ClaimOptions {
  workerId: string;
  limit: number;
  leaseMs: number;
  /** Retry budget. SKIP LOCKED never blocked; Serializable has to retry instead. */
  maxRetries?: number;
}

export interface ClaimedRow {
  id: string;
  guild_id: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  content: string;
  created_at: bigint;
  username: string;
  metadata: string | null;
  attempts: number;
}

class RetryableConflict extends Error {}

const isRetryable = (e: unknown): boolean =>
  e instanceof RetryableConflict ||
  (e instanceof PrismaNS.PrismaClientKnownRequestError &&
    (e.code === SERIALIZATION_FAILURE || e.code === "40P01"));

/**
 * Claim a batch of pending work atomically.
 *
 * The original implementation was `SELECT ... FOR UPDATE SKIP LOCKED` inside a
 * PL/pgSQL function: one statement, N workers each got a disjoint slice, and
 * a worker that died mid-flight simply had its lease expire. Prisma cannot
 * express row-level locking, so this trades that guarantee for retry-on-
 * conflict under SERIALIZABLE, which yields the same outcome — no two workers
 * ever hold the same row — at the cost of an extra round trip per batch and a
 * bounded retry loop.
 *
 * The claim is a compare-and-set, not a read: `updateMany` only touches rows
 * still in a claimable state, so if another worker committed first the WHERE
 * clause matches nothing and we retry rather than double-claiming.
 */
export async function claimMessages(
  client: PrismaClient,
  opts: ClaimOptions,
): Promise<ClaimedRow[]> {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.$transaction(
        async (tx) => {
          const now = Date.now();
          const leaseUntil = BigInt(now + opts.leaseMs);

          const candidates = await tx.messages.findMany({
            where: {
              ai_status: { in: ["pending", "retry_wait"] },
              ready_for_work_at: { lte: BigInt(now) },
              deleted_at: null,
            },
            orderBy: [{ created_at: "asc" }, { id: "asc" }],
            take: opts.limit,
            select: { id: true },
          });

          if (candidates.length === 0) return [];

          const claimed = await tx.messages.updateMany({
            where: {
              id: { in: candidates.map((c) => c.id) },
              ai_status: { in: ["pending", "retry_wait"] },
            },
            data: {
              ai_status: "claimed",
              worker_id: opts.workerId,
              lease_until: leaseUntil,
              attempts: { increment: 1 },
            },
          });

          // Another worker took every candidate between our read and write.
          if (claimed.count === 0) throw new RetryableConflict();

          return tx.messages.findMany({
            where: {
              id: { in: candidates.map((c) => c.id) },
              worker_id: opts.workerId,
              ai_status: "claimed",
            },
            select: {
              id: true,
              guild_id: true,
              channel_id: true,
              thread_id: true,
              user_id: true,
              content: true,
              created_at: true,
              username: true,
              metadata: true,
              attempts: true,
            },
          });
        },
        { isolationLevel: "Serializable", timeout: 15_000 },
      );
    } catch (e) {
      if (!isRetryable(e) || attempt === maxRetries) throw e;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 5));
    }
  }
  return [];
}

/** Return rows whose worker died mid-flight to the pending queue. */
export async function reclaimExpiredClaims(
  client: PrismaClient,
): Promise<number> {
  const { count } = await client.messages.updateMany({
    where: { ai_status: "claimed", lease_until: { lt: BigInt(Date.now()) } },
    data: {
      ai_status: "pending",
      lease_until: null,
      worker_id: null,
      last_error: "lease expired: worker died mid-flight",
    },
  });
  return count;
}