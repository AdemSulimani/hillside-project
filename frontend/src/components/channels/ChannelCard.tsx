import { Card, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getChannelIcon, getChannelLabel } from '@/components/channels/channelMeta';
import type { Channel } from '@/types/channel';

interface ChannelCardProps {
  channel: Channel;
  isDeletePending?: boolean;
  onDisconnect: (channel: Channel) => void;
}

function renderChannelIcon(type: Channel['type']) {
  const Icon = getChannelIcon(type);
  return <Icon className="size-4" />;
}

export function ChannelCard({
  channel,
  isDeletePending = false,
  onDisconnect,
}: ChannelCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg border bg-muted/40 p-2 text-muted-foreground">
              {renderChannelIcon(channel.type)}
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
      <CardFooter className="justify-end border-t pt-4">
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
