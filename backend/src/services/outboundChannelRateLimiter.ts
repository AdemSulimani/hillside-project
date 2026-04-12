import { redisConnection } from '../jobs/redisConnection';

export class OutboundChannelRateLimitedError extends Error {
  constructor(
    message: string,
    readonly channelId: string,
  ) {
    super(message);
    this.name = 'OutboundChannelRateLimitedError';
  }
}

const BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl_sec = tonumber(ARGV[5])

local t = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(t[1])
local updated_at = tonumber(t[2])

if tokens == nil then
  tokens = capacity
  updated_at = now
end

local elapsed = math.max(0, now - updated_at)
local refill = elapsed * refill_per_ms
tokens = math.min(capacity, tokens + refill)
updated_at = now

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HSET', key, 'tokens', tostring(tokens), 'updated_at', tostring(updated_at))
  redis.call('EXPIRE', key, ttl_sec)
  return 1
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'updated_at', tostring(updated_at))
redis.call('EXPIRE', key, ttl_sec)
return 0
`;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bucketKey(channelId: string): string {
  return `rate:outbound:channel:${channelId}`;
}

/**
 * Token-bucket limiter per channel (Graph send API). Defaults: 200 tokens / hour.
 * Refills linearly so steady traffic is smoothed while allowing bursts up to capacity.
 */
export async function acquireOutboundSendToken(
  channelId: string,
  options?: { cost?: number; maxWaitMs?: number },
): Promise<void> {
  const capacity = parsePositiveInt(process.env.OUTBOUND_API_MAX_PER_HOUR, 200);
  const windowSec = parsePositiveInt(process.env.OUTBOUND_API_WINDOW_SEC, 3600);
  const windowMs = windowSec * 1000;
  const refillPerMs = capacity / windowMs;
  const cost = options?.cost ?? 1;
  const maxWaitMs = options?.maxWaitMs ?? 60_000;
  const ttlSec = Math.max(windowSec * 2, 7200);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
    const now = Date.now();
    const granted = await redisConnection.eval(
      BUCKET_LUA,
      1,
      bucketKey(channelId),
      capacity,
      refillPerMs,
      now,
      cost,
      ttlSec,
    );

    if (granted === 1) {
      return;
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  throw new OutboundChannelRateLimitedError(
    `Outbound send rate limit exceeded for channel after ${maxWaitMs}ms`,
    channelId,
  );
}
