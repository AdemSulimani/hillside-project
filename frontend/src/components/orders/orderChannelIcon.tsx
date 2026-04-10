import { Globe, Image, MessageCircleMore, type LucideIcon } from 'lucide-react';
import type { ChannelType } from '@/types/conversation';

export function orderChannelIcon(type: ChannelType): LucideIcon {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}
