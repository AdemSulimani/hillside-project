import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/app';
import { useAuth } from '@/hooks/useAuth';
import { Bell, ChevronDown, LogOut, Building2, UserCircle, Menu } from 'lucide-react';
import { cn, assetUrl } from '@/lib/utils';
import SystemHealthIndicator from '@/components/layouts/SystemHealthIndicator';

export default function Header() {
  const user = useAuthStore((s) => s.user);
  const tenant = useAuthStore((s) => s.tenant);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initials = user?.name
    ? user.name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '?';

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      {/* Mobile menu toggle */}
      <button
        onClick={toggleSidebar}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
      >
        <Menu className="size-5" />
      </button>

      {/* Business identity */}
      <div className="flex items-center gap-2.5 min-w-0">
        {tenant?.logo_url ? (
          <img
            src={assetUrl(tenant.logo_url)}
            alt={tenant.name}
            className="size-7 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
            {tenant?.name?.[0]?.toUpperCase() ?? 'B'}
          </div>
        )}
        <span className="truncate text-sm font-medium">{tenant?.name ?? 'My Business'}</span>
      </div>

      <div className="min-w-0 flex-1" />

      <SystemHealthIndicator />

      {/* Notification bell */}
      <button className="relative rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
        <Bell className="size-5" />
      </button>

      {/* User dropdown */}
      <div ref={dropdownRef} className="relative">
        <button
          onClick={() => setDropdownOpen((prev) => !prev)}
          className="flex items-center gap-2 rounded-lg p-1 pr-2 text-sm hover:bg-muted"
        >
          <div className="flex size-7 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
            {initials}
          </div>
          <span className="hidden max-w-[120px] truncate sm:inline">{user?.name}</span>
          <ChevronDown
            className={cn(
              'hidden size-3.5 text-muted-foreground transition-transform sm:block',
              dropdownOpen && 'rotate-180',
            )}
          />
        </button>

        {dropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg">
            <button
              onClick={() => {
                setDropdownOpen(false);
                navigate('/profile');
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
            >
              <UserCircle className="size-4 text-muted-foreground" />
              My Profile
            </button>
            <button
              onClick={() => {
                setDropdownOpen(false);
                navigate('/business');
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted"
            >
              <Building2 className="size-4 text-muted-foreground" />
              My Business
            </button>
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => {
                setDropdownOpen(false);
                logout();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-destructive hover:bg-muted"
            >
              <LogOut className="size-4" />
              Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
