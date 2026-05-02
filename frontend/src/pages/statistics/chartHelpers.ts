import type {
  StatisticsChannelSlice,
  StatisticsDailyMessages,
  StatisticsDailyOrders,
} from '@/types/statistics';

export interface MessageChartRow {
  date: string;
  total: number;
}

export interface OrderChartRow {
  date: string;
  ordersCreated: number;
  ordersConfirmed: number;
}

export function mergeDailyMessages(
  days: string[],
  rows: StatisticsDailyMessages[],
): MessageChartRow[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  return days.map((date) => {
    const r = map.get(date);
    const received = r?.messageReceived ?? 0;
    const ai = r?.aiReplies ?? 0;
    const human = r?.humanReplies ?? 0;
    return { date, total: received + ai + human };
  });
}

export function mergeDailyOrders(days: string[], rows: StatisticsDailyOrders[]): OrderChartRow[] {
  const map = new Map(rows.map((r) => [r.date, r]));
  return days.map((date) => {
    const r = map.get(date);
    return {
      date,
      ordersCreated: r?.ordersCreated ?? 0,
      ordersConfirmed: r?.ordersConfirmed ?? 0,
    };
  });
}

export function channelPieData(rows: StatisticsChannelSlice[]): { name: string; value: number }[] {
  return rows.map((r) => ({
    name: formatChannelLabel(r.channelType),
    value: r.count,
  }));
}

export function formatChannelLabel(channelType: string): string {
  const c = channelType.toLowerCase();
  if (c === 'whatsapp') return 'WhatsApp';
  if (c === 'facebook') return 'Facebook';
  if (c === 'instagram') return 'Instagram';
  if (c === 'unknown') return 'E panjohur';
  return channelType.charAt(0).toUpperCase() + channelType.slice(1);
}

export function formatChartTickDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${m}/${d}`;
}

const moneyFmt = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export function formatMoney(n: number): string {
  return moneyFmt.format(n);
}

export function totalMessagesInSummary(summary: {
  messagesReceived: number;
  aiReplies: number;
  humanReplies: number;
}): number {
  return summary.messagesReceived + summary.aiReplies + summary.humanReplies;
}

export function aiResponseRate(summary: {
  aiReplies: number;
  humanReplies: number;
}): number {
  const denom = summary.aiReplies + summary.humanReplies;
  if (denom <= 0) return 0;
  return summary.aiReplies / denom;
}
