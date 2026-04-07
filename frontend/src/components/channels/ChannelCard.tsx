import { Bot, Globe, Image, MessageCircleMore } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { Channel } from '@/types/channel';

interface ChannelCardProps {
  channel: Channel;
  isTogglePending?: boolean;
  isDeletePending?: boolean;
  onToggleAI: (channel: Channel) => void;
  onDisconnect: (channel: Channel) => void;
}

function getChannelIcon(type: Channel['type']) {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}

function getChannelLabel(type: Channel['type']) {
  if (type === 'facebook') return 'Facebook';
  if (type === 'instagram') return 'Instagram';
  return 'WhatsApp';
}

export function ChannelCard({
  channel,
  isTogglePending = false,
  isDeletePending = false,
  onToggleAI,
  onDisconnect,
}: ChannelCardProps) {
  const Icon = getChannelIcon(channel.type);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg border bg-muted/40 p-2 text-muted-foreground">
              <Icon className="size-4" />
            </div>
            <div>
              <CardTitle>{channel.name}</CardTitle>
              <p className="text-xs text-muted-foreground">{getChannelLabel(channel.type)}</p>
            </div>
          </div>
          <Badge variant={channel.webhook_verified ? 'default' : 'secondary'}>
            {channel.webhook_verified ? 'Connected' : 'Pending verification'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Bot className="size-4 text-muted-foreground" />
            AI assistant
          </div>
          <Switch
            checked={channel.ai_enabled}
            onCheckedChange={() => onToggleAI(channel)}
            disabled={isTogglePending}
            aria-label={`Toggle AI for ${channel.name}`}
          />
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          variant="destructive"
          size="sm"
          disabled={isDeletePending}
          onClick={() => onDisconnect(channel)}
        >
          {isDeletePending ? 'Disconnecting…' : 'Disconnect'}
        </Button>
      </CardFooter>
    </Card>
  );
}
