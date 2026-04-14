import { Suspense } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import { useAdminAuthStore } from '@/store/adminAuthStore';
import { Button } from '@/components/ui/button';
import { CRMRouteFallback } from '@/components/layouts/RouteFallback';
import AdminSidebar from '@/components/layouts/AdminSidebar';
import LegalFooter from '@/components/layouts/LegalFooter';
import { useAppStore } from '@/store/app';

export default function AdminLayout() {
  const navigate = useNavigate();
  const clearAuth = useAdminAuthStore((s) => s.clearAuth);
  const owner = useAdminAuthStore((s) => s.owner);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  function handleLogout() {
    clearAuth();
    navigate('/admin/login', { replace: true });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 md:px-6">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <span className="text-sm text-muted-foreground truncate">
              Signed in as <span className="font-medium text-foreground">{owner?.email}</span>
            </span>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleLogout} className="gap-2">
            <LogOut className="size-4" />
            Log out
          </Button>
        </header>

        <main className="flex flex-1 flex-col overflow-y-auto p-4 md:p-6">
          <Suspense fallback={<CRMRouteFallback />}>
            <Outlet />
          </Suspense>
          <LegalFooter />
        </main>
      </div>
    </div>
  );
}
