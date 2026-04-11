export interface StatisticsTopProduct {
  productId: string | null;
  name: string;
  unitsSold: number;
  revenue: number;
}

export interface StatisticsDailyMessages {
  date: string;
  messageReceived: number;
  aiReplies: number;
  humanReplies: number;
}

export interface StatisticsDailyOrders {
  date: string;
  ordersCreated: number;
  ordersConfirmed: number;
}

export interface StatisticsChannelSlice {
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
  topProducts: StatisticsTopProduct[];
  dailyMessages: StatisticsDailyMessages[];
  dailyOrders: StatisticsDailyOrders[];
  channelBreakdown: StatisticsChannelSlice[];
}
