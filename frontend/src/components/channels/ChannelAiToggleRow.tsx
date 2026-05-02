import { Bot } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { getChannelIcon, getChannelLabel } from '@/components/channels/channelMeta';
import type { Channel } from '@/types/channel';

interface ChannelAiToggleRowProps {
  channel: Channel;
  isTogglePending?: boolean;
  onToggleAI: (channel: Channel) => void;
}

function renderChannelIcon(type: Channel['type']) {
  const Icon = getChannelIcon(type);
  return <Icon className="size-4" />;
}

export function ChannelAiToggleRow({
  channel,
  isTogglePending = false,
  onToggleAI,
}: ChannelAiToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="shrink-0 rounded-lg border bg-muted/40 p-2 text-muted-foreground">
          {renderChannelIcon(channel.type)}
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium leading-tight">{channel.name}</p>
          <p className="text-xs text-muted-foreground">{getChannelLabel(channel.type)}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Bot className="size-4 text-muted-foreground max-sm:hidden" aria-hidden />
        <span className="text-sm text-muted-foreground max-md:hidden">IA</span>
        <Switch
          checked={channel.ai_enabled}
          onCheckedChange={() => onToggleAI(channel)}
          disabled={isTogglePending}
          aria-label={`Ndërro IA-në për ${channel.name}`}
        />
      </div>
    </div>
  );
}
