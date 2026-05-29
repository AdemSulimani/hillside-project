import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '@/store/app';
import { cn } from '@/lib/utils';
import { fetchUnreadConversationCount } from '@/api/conversationsApi';
import { fetchAIAlertsUnreadCount } from '@/api/aiAlertsApi';
import {
  LayoutDashboard,
  Inbox,
  Package,
  Radio,
  ShoppingCart,
  Users,
  Bot,
  BarChart3,
  MessageSquareHeart,
  ShieldAlert,
  CreditCard,
  Building2,
  UserCircle,
  X,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/channels', label: 'Channels', icon: Radio },
  { to: '/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/chatbot-control', label: 'Chatbot Control', icon: Bot },
  { to: '/statistics', label: 'Statistics', icon: BarChart3 },
  { to: '/feedback', label: 'Feedback', icon: MessageSquareHeart },
  { to: '/ai-alerts', label: 'AI Alerts', icon: ShieldAlert },
  { to: '/credits', label: 'Credits', icon: CreditCard },
  { to: '/business', label: 'My Business', icon: Building2 },
  { to: '/profile', label: 'My Profile', icon: UserCircle },
] as const;

export default function Sidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const ordersNavNewCount = useAppStore((s) => s.ordersNavNewCount);

  const { data: inboxUnread = 0 } = useQuery({
    queryKey: ['conversations', 'unread-count'],
    queryFn: fetchUnreadConversationCount,
    refetchInterval: 60_000,
  });

  const { data: aiAlertsUnread = 0 } = useQuery({
    queryKey: ['ai-alerts', 'unread-count'],
    queryFn: fetchAIAlertsUnreadCount,
    refetchInterval: 60_000,
  });

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 ease-in-out md:relative md:z-auto md:h-svh md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
          <span className="text-base font-semibold text-sidebar-foreground tracking-tight">
            Hillside CRM
          </span>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"
            aria-label="Close sidebar"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3">
          <ul className="flex flex-col gap-0.5">
            {navItems.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  onClick={() => {
                    if (window.innerWidth < 768) setSidebarOpen(false);
                  }}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {to === '/inbox' && inboxUnread > 0 ? (
                    <span className="flex min-w-5 justify-center rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-primary-foreground">
                      {inboxUnread > 99 ? '99+' : inboxUnread}
                    </span>
                  ) : null}
                  {to === '/ai-alerts' && aiAlertsUnread > 0 ? (
                    <span className="flex min-w-5 justify-center rounded-full bg-destructive px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-destructive-foreground">
                      {aiAlertsUnread > 99 ? '99+' : aiAlertsUnread}
                    </span>
                  ) : null}
                  {to === '/orders' && ordersNavNewCount > 0 ? (
                    <span
                      className="flex min-w-5 justify-center rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-primary-foreground"
                      title="New orders since your last visit to the orders page"
                    >
                      {ordersNavNewCount > 99 ? '99+' : ordersNavNewCount}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  );
}
