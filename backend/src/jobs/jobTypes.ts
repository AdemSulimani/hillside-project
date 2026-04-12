import type { ChannelType } from '../db/models/channel';

export interface InboundWebhookJobData {
  channelType: ChannelType;
  payload: Record<string, unknown>;
}
