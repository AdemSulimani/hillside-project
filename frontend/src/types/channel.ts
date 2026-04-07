export type ChannelType = 'facebook' | 'instagram' | 'whatsapp';

export interface Channel {
  id: string;
  tenant_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  webhook_verified: boolean;
  ai_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnectBody {
  phoneNumberId: string;
  accessToken: string;
  name?: string;
}
