import { Globe, Image, MessageCircleMore, type LucideIcon } from 'lucide-react';
import type { ChannelType } from '@/types/conversation';

export function channelIcon(type: ChannelType): LucideIcon {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}

export function channelLabel(type: ChannelType): string {
  if (type === 'facebook') return 'Facebook';
  if (type === 'instagram') return 'Instagram';
  return 'WhatsApp';
}
