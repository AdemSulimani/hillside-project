import { Bot, Globe, Image, MessageCircleMore } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { Channel } from '@/types/channel';

export function getChannelIcon(type: Channel['type']) {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}

export function getChannelLabel(type: Channel['type']) {
  if (type === 'facebook') return 'Facebook';
  if (type === 'instagram') return 'Instagram';
  return 'WhatsApp';
}

interface ChannelAiToggleRowProps {
  channel: Channel;
  isTogglePending?: boolean;
  onToggleAI: (channel: Channel) => void;
}

export function ChannelAiToggleRow({
  channel,
  isTogglePending = false,
  onToggleAI,
}: ChannelAiToggleRowProps) {
  const Icon = getChannelIcon(channel.type);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="shrink-0 rounded-lg border bg-muted/40 p-2 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium leading-tight">{channel.name}</p>
          <p className="text-xs text-muted-foreground">{getChannelLabel(channel.type)}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Bot className="size-4 text-muted-foreground max-sm:hidden" aria-hidden />
        <span className="text-sm text-muted-foreground max-md:hidden">AI</span>
        <Switch
          checked={channel.ai_enabled}
          onCheckedChange={() => onToggleAI(channel)}
          disabled={isTogglePending}
          aria-label={`Toggle AI for ${channel.name}`}
        />
      </div>
    </div>
  );
}
