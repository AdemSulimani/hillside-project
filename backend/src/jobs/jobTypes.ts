import type { ChannelType } from '../db/models/channel';

export interface InboundWebhookJobData {
  channelType: ChannelType;
  payload: Record<string, unknown>;
  /**
   * Correlation ID generated at webhook ingestion time (crypto.randomUUID).
   * Propagated through every downstream job so a single `grep traceId=<uuid>`
   * in logs returns the complete lifecycle of one inbound message.
   */
  traceId: string;
}
