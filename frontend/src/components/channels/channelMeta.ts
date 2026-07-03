import { Globe, Image, MessageCircleMore, Phone, type LucideIcon } from 'lucide-react';
import type { Channel } from '@/types/channel';

export function getChannelIcon(type: Channel['type']): LucideIcon {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  if (type === 'viber') return Phone;
  return MessageCircleMore;
}

export function getChannelLabel(type: Channel['type']): string {
  if (type === 'facebook') return 'Facebook';
  if (type === 'instagram') return 'Instagram';
  if (type === 'viber') return 'Viber';
  return 'WhatsApp';
}
