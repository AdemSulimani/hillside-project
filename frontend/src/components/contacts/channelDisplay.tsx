import { Globe, Image, MessageCircleMore, type LucideIcon } from 'lucide-react';
import type { ChannelType } from '@/types/conversation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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

export function ChannelTypeBadge({
  type,
  className,
  showLabel = true,
}: {
  type: ChannelType;
  className?: string;
  showLabel?: boolean;
}) {
  const Icon = channelIcon(type);
  return (
    <Badge variant="secondary" className={cn('gap-1 font-normal capitalize', className)}>
      <Icon className="size-3" aria-hidden />
      {showLabel ? channelLabel(type) : null}
    </Badge>
  );
}
