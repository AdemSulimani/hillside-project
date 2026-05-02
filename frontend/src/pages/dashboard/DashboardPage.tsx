import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { MessageSquare, ShoppingCart, Users, Radio } from 'lucide-react';
import type { ApiResponse } from '@/types';

interface DashboardSummary {
  messagesToday: number;
  totalOrders: number;
  totalContacts: number;
  activeChannels: number;
}

const metricConfig = [
  { key: 'messagesToday', label: 'Mesazhe sot', icon: MessageSquare },
  { key: 'totalOrders', label: 'Porosi gjithsej', icon: ShoppingCart },
  { key: 'totalContacts', label: 'Kontakte gjithsej', icon: Users },
  { key: 'activeChannels', label: 'Kanale aktive', icon: Radio },
] as const;

export default function DashboardPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<DashboardSummary>>('/dashboard/summary');
      return data.data!;
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Paneli</h1>
        <p className="text-sm text-muted-foreground">
          Pamje e shpejtë e biznesit tuaj.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          : metricConfig.map(({ key, label, icon: Icon }) => (
              <Card key={key}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      {label}
                    </CardTitle>
                    <Icon className="size-4 text-muted-foreground" />
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">
                    {isError ? '—' : (data?.[key] ?? 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))}
      </div>
    </div>
  );
}
