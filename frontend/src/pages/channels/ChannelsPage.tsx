import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, Plus, Radio } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { deleteChannel, fetchChannels, getInstagramRedirectUrl, getMetaRedirectUrl } from '@/api/channelsApi';
import { ChannelCard } from '@/components/channels/ChannelCard';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWhatsAppEmbeddedSignup } from '@/hooks/useWhatsAppEmbeddedSignup';

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
  const { startSignup, isPending: whatsAppSignupPending } = useWhatsAppEmbeddedSignup();

  const { data: channels = [], isLoading, isError } = useQuery({
    queryKey: ['channels'],
    queryFn: fetchChannels,
  });

  const connectFacebookMutation = useMutation({
    mutationFn: getMetaRedirectUrl,
    onSuccess: (url) => {
      window.location.assign(url);
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Could not start Facebook OAuth connection'));
    },
  });

  const connectInstagramMutation = useMutation({
    mutationFn: getInstagramRedirectUrl,
    onSuccess: (url) => {
      window.location.assign(url);
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Could not start Instagram OAuth connection'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChannel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Channel disconnected');
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Channel disconnect failed'));
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

  async function handleConnectWhatsApp(): Promise<void> {
    const ok = await startSignup();
    if (ok) {
      toast.success('WhatsApp connected successfully');
    }
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
            onClick={() => connectFacebookMutation.mutate()}
            disabled={connectFacebookMutation.isPending}
          >
            {connectFacebookMutation.isPending && <Loader2 className="animate-spin" />}
            <Plus className="size-4" />
            Connect Facebook
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => connectInstagramMutation.mutate()}
            disabled={connectInstagramMutation.isPending}
          >
            {connectInstagramMutation.isPending && <Loader2 className="animate-spin" />}
            <Plus className="size-4" />
            Connect Instagram
          </Button>
          <Button
            type="button"
            onClick={() => void handleConnectWhatsApp()}
            disabled={whatsAppSignupPending}
          >
            {whatsAppSignupPending && <Loader2 className="animate-spin" />}
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
          Channels could not be loaded. Please refresh the page.
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
    </div>
  );
}
