import { useEffect, useState } from 'react';
import { restoreSessionOnce } from '@/lib/sessionRestore';
import { Spinner } from '@/components/ui/spinner';
import App from './App';

export default function AppWithSessionRestore() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    restoreSessionOnce().finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Po rikthehet sesioni"
      >
        <Spinner className="size-10 text-primary" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Po rikthehet sesioni juaj…</p>
          <p className="mt-1 text-xs text-muted-foreground">Duke kontrolluar llogarinë dhe hapësirën e punës.</p>
        </div>
      </div>
    );
  }

  return <App />;
}
