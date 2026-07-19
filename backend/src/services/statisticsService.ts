// P3-2: replica-tolerant analytics reads. With DATABASE_REPLICA_URL unset this IS db/pool.
import pool from '../db/readPool';
import { redisConnection } from '../jobs/queues';

const STATS_CACHE_TTL_SECONDS = 300;

export interface TopProductRow {
  productId: string | null;
  name: string;
  unitsSold: number;
  revenue: number;
}

export interface DailyMessageRow {
  date: string;
  messageReceived: number;
  aiReplies: number;
  humanReplies: number;
}

export interface DailyOrderRow {
  date: string;
  ordersCreated: number;
  ordersConfirmed: number;
}

export interface ChannelBreakdownRow {
  channelType: string;
  count: number;
}

export interface StatisticsSummary {
  messagesReceived: number;
  aiReplies: number;
  humanReplies: number;
  ordersCreated: number;
  ordersConfirmed: number;
  feedbackSubmitted: number;
  conversionRate: number;
  topProducts: TopProductRow[];
  dailyMessages: DailyMessageRow[];
  dailyOrders: DailyOrderRow[];
  channelBreakdown: ChannelBreakdownRow[];
}

function statsCacheKey(tenantId: string, start: Date, end: Date): string {
  return `stats:${tenantId}:${start.toISOString()}:${end.toISOString()}`;
}

async function readCache(key: string): Promise<StatisticsSummary | null> {
  try {
    const raw = await redisConnection.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as StatisticsSummary;
  } catch (err) {
    console.warn('[statistics] Redis get failed, computing fresh', err);
    return null;
  }
}

async function writeCache(key: string, payload: StatisticsSummary): Promise<void> {
  try {
    await redisConnection.setex(key, STATS_CACHE_TTL_SECONDS, JSON.stringify(payload));
  } catch (err) {
    console.warn('[statistics] Redis setex failed', err);
  }
}

async function countEventsByType(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ event_type: string; cnt: string }>(
    `SELECT event_type, COUNT(*)::text AS cnt
     FROM analytics_events
     WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at <= $3
     GROUP BY event_type`,
    [tenantId, start, end],
  );
  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.event_type] = parseInt(r.cnt, 10);
  }
  return map;
}

async function fetchTopProducts(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<TopProductRow[]> {
  const { rows } = await pool.query<{
    product_id: string | null;
    name: string;
    units_sold: string;
    revenue: string;
  }>(
    `SELECT
       o.product_id,
       COALESCE(p.name, o.product_name) AS name,
       SUM(o.quantity)::text AS units_sold,
       SUM(o.total_price)::text AS revenue
     FROM orders o
     LEFT JOIN products p ON p.id = o.product_id AND p.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1 AND o.created_at >= $2 AND o.created_at <= $3
     GROUP BY o.product_id, COALESCE(p.name, o.product_name)
     ORDER BY SUM(o.quantity) DESC
     LIMIT 5`,
    [tenantId, start, end],
  );

  return rows.map((r) => ({
    productId: r.product_id,
    name: r.name,
    unitsSold: parseInt(r.units_sold, 10),
    revenue: parseFloat(r.revenue),
  }));
}

async function fetchDailyMessages(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<DailyMessageRow[]> {
  const { rows } = await pool.query<{
    day: string;
    message_received: string;
    ai_replies: string;
    human_replies: string;
  }>(
    `SELECT
       (occurred_at AT TIME ZONE 'UTC')::date::text AS day,
       SUM(CASE WHEN event_type = 'message_received' THEN 1 ELSE 0 END)::text AS message_received,
       SUM(CASE WHEN event_type = 'ai_reply_sent' THEN 1 ELSE 0 END)::text AS ai_replies,
       SUM(CASE WHEN event_type = 'human_reply_sent' THEN 1 ELSE 0 END)::text AS human_replies
     FROM analytics_events
     WHERE tenant_id = $1
       AND occurred_at >= $2
       AND occurred_at <= $3
       AND event_type IN ('message_received', 'ai_reply_sent', 'human_reply_sent')
     GROUP BY 1
     ORDER BY 1`,
    [tenantId, start, end],
  );

  return rows.map((r) => ({
    date: r.day,
    messageReceived: parseInt(r.message_received, 10),
    aiReplies: parseInt(r.ai_replies, 10),
    humanReplies: parseInt(r.human_replies, 10),
  }));
}

async function fetchDailyOrders(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<DailyOrderRow[]> {
  const { rows } = await pool.query<{
    day: string;
    orders_created: string;
    orders_confirmed: string;
  }>(
    `SELECT
       (occurred_at AT TIME ZONE 'UTC')::date::text AS day,
       SUM(CASE WHEN event_type = 'order_created' THEN 1 ELSE 0 END)::text AS orders_created,
       SUM(CASE WHEN event_type = 'order_confirmed' THEN 1 ELSE 0 END)::text AS orders_confirmed
     FROM analytics_events
     WHERE tenant_id = $1
       AND occurred_at >= $2
       AND occurred_at <= $3
       AND event_type IN ('order_created', 'order_confirmed')
     GROUP BY 1
     ORDER BY 1`,
    [tenantId, start, end],
  );

  return rows.map((r) => ({
    date: r.day,
    ordersCreated: parseInt(r.orders_created, 10),
    ordersConfirmed: parseInt(r.orders_confirmed, 10),
  }));
}

async function fetchChannelBreakdown(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<ChannelBreakdownRow[]> {
  const { rows } = await pool.query<{ channel_type: string; cnt: string }>(
    `SELECT
       COALESCE(NULLIF(metadata->>'channel_type', ''), 'unknown') AS channel_type,
       COUNT(*)::text AS cnt
     FROM analytics_events
     WHERE tenant_id = $1
       AND occurred_at >= $2
       AND occurred_at <= $3
       AND event_type = 'message_received'
     GROUP BY 1
     ORDER BY COUNT(*) DESC`,
    [tenantId, start, end],
  );

  return rows.map((r) => ({
    channelType: r.channel_type,
    count: parseInt(r.cnt, 10),
  }));
}

function buildSummaryFromCounts(
  counts: Record<string, number>,
  topProducts: TopProductRow[],
  dailyMessages: DailyMessageRow[],
  dailyOrders: DailyOrderRow[],
  channelBreakdown: ChannelBreakdownRow[],
): StatisticsSummary {
  const messagesReceived = counts.message_received ?? 0;
  const aiReplies = counts.ai_reply_sent ?? 0;
  const humanReplies = counts.human_reply_sent ?? 0;
  const ordersCreated = counts.order_created ?? 0;
  const ordersConfirmed = counts.order_confirmed ?? 0;
  const feedbackSubmitted = counts.feedback_submitted ?? 0;

  const conversionRate =
    ordersCreated > 0 ? Math.round((10000 * ordersConfirmed) / ordersCreated) / 10000 : 0;

  return {
    messagesReceived,
    aiReplies,
    humanReplies,
    ordersCreated,
    ordersConfirmed,
    feedbackSubmitted,
    conversionRate,
    topProducts,
    dailyMessages,
    dailyOrders,
    channelBreakdown,
  };
}

export async function getStatisticsSummary(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<StatisticsSummary> {
  const cacheKey = statsCacheKey(tenantId, start, end);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  const [countsMap, topProducts, dailyMessages, dailyOrders, channelBreakdown] = await Promise.all([
    countEventsByType(tenantId, start, end),
    fetchTopProducts(tenantId, start, end),
    fetchDailyMessages(tenantId, start, end),
    fetchDailyOrders(tenantId, start, end),
    fetchChannelBreakdown(tenantId, start, end),
  ]);

  const summary = buildSummaryFromCounts(
    countsMap,
    topProducts,
    dailyMessages,
    dailyOrders,
    channelBreakdown,
  );

  // Avoid caching an "all zeros" event snapshot: new webhooks/replies would stay invisible for TTL minutes.
  const eventActivity =
    summary.messagesReceived +
    summary.aiReplies +
    summary.humanReplies +
    summary.ordersCreated +
    summary.ordersConfirmed +
    summary.feedbackSubmitted;
  if (eventActivity > 0) {
    void writeCache(cacheKey, summary);
  }

  return summary;
}
