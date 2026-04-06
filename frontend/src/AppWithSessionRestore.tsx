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
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );
  }

  return <App />;
}
