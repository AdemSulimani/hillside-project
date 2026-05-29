import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { CRMRouteFallback } from '@/components/layouts/RouteFallback';
import { CrmSocketProvider } from '@/contexts/CrmSocketContext';
import { useOrderCreatedToast } from '@/hooks/useOrderCreatedToast';
import { useAiAlertToast } from '@/hooks/useAiAlertToast';
import { useOrderActionRequiredToast } from '@/hooks/useOrderActionRequiredToast';
import Sidebar from './Sidebar';
import Header from './Header';
import LegalFooter from './LegalFooter';

function CrmRealtimeListeners() {
  useOrderCreatedToast();
  useAiAlertToast();
  useOrderActionRequiredToast();
  return null;
}

export default function CRMLayout() {
  return (
    <CrmSocketProvider>
      <CrmRealtimeListeners />
      <div className="flex h-svh overflow-hidden bg-background">
        <Sidebar />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Header />
          <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-4 md:p-6">
            <Suspense fallback={<CRMRouteFallback />}>
              <Outlet />
            </Suspense>
            <LegalFooter />
          </main>
        </div>
      </div>
    </CrmSocketProvider>
  );
}
