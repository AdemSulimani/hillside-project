import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, Plus, Radio } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  connectWhatsApp,
  deleteChannel,
  fetchChannels,
  getMetaRedirectUrl,
} from '@/api/channelsApi';
import { ChannelCard } from '@/components/channels/ChannelCard';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

export default function ChannelsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [whatsAppOpen, setWhatsAppOpen] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [displayName, setDisplayName] = useState('');

  const { data: channels = [], isLoading, isError } = useQuery({
    queryKey: ['channels'],
    queryFn: fetchChannels,
  });

  const connectMetaMutation = useMutation({
    mutationFn: (type: 'facebook' | 'instagram') => getMetaRedirectUrl(type),
    onSuccess: (url) => {
      window.location.assign(url);
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Failed to start Meta OAuth flow'));
    },
  });

  const connectWhatsAppMutation = useMutation({
    mutationFn: connectWhatsApp,
    onSuccess: () => {
      setWhatsAppOpen(false);
      setPhoneNumberId('');
      setAccessToken('');
      setDisplayName('');
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('WhatsApp channel connected');
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Failed to connect WhatsApp channel'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChannel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel disconnected');
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Failed to disconnect channel'));
    },
  });

  useEffect(() => {
    const status = searchParams.get('status');
    const type = searchParams.get('type');

    if (status === 'connected' && type) {
      const label = type === 'instagram' ? 'Instagram' : type === 'whatsapp' ? 'WhatsApp' : 'Facebook';
      toast.success(`${label} connected successfully`);
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      navigate('/channels', { replace: true });
      return;
    }

    if (status === 'error') {
      toast.error('Channel connection failed');
      navigate('/channels', { replace: true });
    }
  }, [navigate, queryClient, searchParams]);

  const pendingDeleteIds = useMemo(
    () => new Set(deleteMutation.isPending ? [deleteMutation.variables] : []),
    [deleteMutation.isPending, deleteMutation.variables],
  );

  function submitWhatsAppConnect() {
    const phone = phoneNumberId.trim();
    const token = accessToken.trim();

    if (!phone || !token) {
      toast.error('Phone Number ID and Access Token are required');
      return;
    }

    connectWhatsAppMutation.mutate({
      phoneNumberId: phone,
      accessToken: token,
      name: displayName.trim() || undefined,
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
          <p className="text-sm text-muted-foreground">
            Connect your social channels. Manage AI per channel in{' '}
            <Link
              to="/chatbot-control"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              Chatbot Control
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => connectMetaMutation.mutate('facebook')}
            disabled={connectMetaMutation.isPending}
          >
            {connectMetaMutation.isPending && connectMetaMutation.variables === 'facebook' && (
              <Loader2 className="animate-spin" />
            )}
            <Plus className="size-4" />
            Connect Facebook
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => connectMetaMutation.mutate('instagram')}
            disabled={connectMetaMutation.isPending}
          >
            {connectMetaMutation.isPending && connectMetaMutation.variables === 'instagram' && (
              <Loader2 className="animate-spin" />
            )}
            <Plus className="size-4" />
            Connect Instagram
          </Button>
          <Button type="button" onClick={() => setWhatsAppOpen(true)}>
            <Plus className="size-4" />
            Connect WhatsApp
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Could not load channels. Please refresh.
        </div>
      ) : channels.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Radio className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">No channels connected yet.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              isDeletePending={pendingDeleteIds.has(channel.id)}
              onDisconnect={(target) => deleteMutation.mutate(target.id)}
            />
          ))}
        </div>
      )}

      <Dialog open={whatsAppOpen} onOpenChange={setWhatsAppOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect WhatsApp Cloud API</DialogTitle>
            <DialogDescription>
              Paste your WhatsApp Cloud API credentials to verify and connect this channel.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="whatsapp-phone-id">Phone Number ID</Label>
              <Input
                id="whatsapp-phone-id"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="e.g. 123456789012345"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="whatsapp-access-token">Access Token</Label>
              <Input
                id="whatsapp-access-token"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Paste your permanent token"
                type="password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="whatsapp-display-name">Channel Name (optional)</Label>
              <Input
                id="whatsapp-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Support WhatsApp"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setWhatsAppOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitWhatsAppConnect}
              disabled={connectWhatsAppMutation.isPending}
            >
              {connectWhatsAppMutation.isPending && <Loader2 className="animate-spin" />}
              {connectWhatsAppMutation.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
