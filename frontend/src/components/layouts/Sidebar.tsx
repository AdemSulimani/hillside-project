import { NavLink } from 'react-router-dom';
import { useAppStore } from '@/store/app';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Inbox,
  Package,
  Radio,
  ShoppingCart,
  Users,
  BrainCircuit,
  Bot,
  BarChart3,
  MessageSquareHeart,
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
  { to: '/ai-config', label: 'AI Config', icon: BrainCircuit },
  { to: '/chatbot-control', label: 'Chatbot Control', icon: Bot },
  { to: '/statistics', label: 'Statistics', icon: BarChart3 },
  { to: '/feedback', label: 'Feedback', icon: MessageSquareHeart },
  { to: '/business', label: 'My Business', icon: Building2 },
  { to: '/profile', label: 'My Profile', icon: UserCircle },
] as const;

export default function Sidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
          <span className="text-base font-semibold text-sidebar-foreground tracking-tight">
            Hillside CRM
          </span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground md:hidden"
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
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  );
}
