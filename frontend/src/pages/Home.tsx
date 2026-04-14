import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import { Button } from '@/components/ui/button';
import LegalFooter from '@/components/layouts/LegalFooter';

interface HealthData {
  status: string;
  database: { connected: boolean; responseTime: string };
  uptime: number;
  timestamp: string;
}

function useHealthCheck() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<HealthData>>('/health');
      return data;
    },
    enabled: false,
  });
}

export default function HomePage() {
  const { data, refetch, isFetching, isError, error } = useHealthCheck();

  const checkHealth = async () => {
    const result = await refetch();
    if (result.isSuccess) {
      toast.success('Backend is healthy!');
    } else {
      toast.error('Failed to reach backend');
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Hillside Project
        </h1>
        <p className="mt-2 text-muted-foreground">
          Frontend is running. Click below to verify the backend connection.
        </p>
      </div>

      <Button onClick={checkHealth} disabled={isFetching} size="lg">
        {isFetching ? 'Checking...' : 'Check API Health'}
      </Button>

      {data && (
        <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">Health Response</h2>
          <pre className="overflow-auto rounded-md bg-muted p-4 text-sm">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}

      {isError && (
        <div className="w-full max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <h2 className="mb-2 text-lg font-semibold text-destructive">
            Connection Error
          </h2>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : 'Could not reach the backend.'}
          </p>
        </div>
      )}

      <div className="w-full max-w-md">
        <LegalFooter />
      </div>
    </div>
  );
}
