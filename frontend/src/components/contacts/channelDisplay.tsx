import type { ChannelType } from '@/types/conversation';
import { Badge } from '@/components/ui/badge';
import { channelIcon, channelLabel } from '@/components/contacts/channelMeta';
import { cn } from '@/lib/utils';

function renderChannelIcon(type: ChannelType) {
  const Icon = channelIcon(type);
  return <Icon className="size-3" aria-hidden />;
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
  return (
    <Badge variant="secondary" className={cn('gap-1 font-normal capitalize', className)}>
      {renderChannelIcon(type)}
      {showLabel ? channelLabel(type) : null}
    </Badge>
  );
}
