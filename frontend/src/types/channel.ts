export type ChannelType = 'facebook' | 'instagram' | 'whatsapp' | 'viber';
export type ChannelConnectionMethod =
  | 'oauth_meta'
  | 'oauth_instagram'
  | 'manual'
  | 'embedded_signup'
  | 'viber_bot';

export interface Channel {
  id: string;
  tenant_id: string;
  type: ChannelType;
  name: string;
  external_id: string;
  connection_method: ChannelConnectionMethod;
  webhook_verified: boolean;
  ai_enabled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}
