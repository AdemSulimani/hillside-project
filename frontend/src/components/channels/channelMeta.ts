import { Globe, Image, MessageCircleMore, type LucideIcon } from 'lucide-react';
import type { Channel } from '@/types/channel';

export function getChannelIcon(type: Channel['type']): LucideIcon {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}

export function getChannelLabel(type: Channel['type']): string {
  if (type === 'facebook') return 'Facebook';
  if (type === 'instagram') return 'Instagram';
  return 'WhatsApp';
}
