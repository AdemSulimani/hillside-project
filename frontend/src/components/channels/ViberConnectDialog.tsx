import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { connectViber } from '@/api/channelsApi';
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

interface ViberConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

export function ViberConnectDialog({ open, onOpenChange }: ViberConnectDialogProps) {
  const [authToken, setAuthToken] = useState('');
  const queryClient = useQueryClient();

  const connectMutation = useMutation({
    mutationFn: () => connectViber(authToken.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      toast.success('Viber bot connected successfully');
      setAuthToken('');
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(extractErrorMessage(err, 'Failed to connect Viber bot'));
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authToken.trim()) return;
    connectMutation.mutate();
  }

  function handleOpenChange(next: boolean) {
    if (!connectMutation.isPending) {
      if (!next) setAuthToken('');
      onOpenChange(next);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Viber Bot</DialogTitle>
          <DialogDescription>
            Enter your Viber bot authentication token to connect it as a messaging channel.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="viber-auth-token">Bot Authentication Token</Label>
            <Input
              id="viber-auth-token"
              type="password"
              placeholder="Enter your Viber bot auth token"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              disabled={connectMutation.isPending}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Find your token in the Viber app under{' '}
              <span className="font-medium">More → Settings → Bots → Edit Info → Your app key</span>.
            </p>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How to get your bot token:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>
                Create a Viber bot via{' '}
                <a
                  href="https://partners.viber.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
                >
                  Viber Admin Panel <ExternalLink className="size-3" />
                </a>
              </li>
              <li>Open your Viber app and go to your bot settings</li>
              <li>Copy the authentication token (app key)</li>
              <li>Paste it above and click Connect</li>
            </ol>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={connectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!authToken.trim() || connectMutation.isPending}
            >
              {connectMutation.isPending && <Loader2 className="animate-spin" />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
