import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';
import RequireOnboarding from '@/components/auth/RequireOnboarding';
import CRMLayout from '@/components/layouts/CRMLayout';
import { FullPageRouteFallback } from '@/components/layouts/RouteFallback';
import { Users, BrainCircuit, Bot, BarChart3, MessageSquareHeart } from 'lucide-react';

const HomePage = lazy(() => import('@/pages/Home'));
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage'));
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage'));
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
const ProfilePage = lazy(() => import('@/pages/profile/ProfilePage'));
const BusinessPage = lazy(() => import('@/pages/business/BusinessPage'));
const PlaceholderPage = lazy(() => import('@/pages/crm/PlaceholderPage'));
const ProductsPage = lazy(() => import('@/pages/products/ProductsPage'));
const ChannelsPage = lazy(() => import('@/pages/channels/ChannelsPage'));
const InboxPage = lazy(() => import('@/pages/inbox/InboxPage'));
const AIConfigPage = lazy(() => import('@/pages/aiConfig/AIConfigPage'));
const OrdersPage = lazy(() => import('@/pages/orders/OrdersPage'));

export default function App() {
  // Keeps BrainCircuit in scope for dev/HMR if a route chunk still referenced it without importing.
  void BrainCircuit;

  return (
    <Suspense fallback={<FullPageRouteFallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />

        <Route element={<PublicOnlyRoute />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route element={<ProtectedRoute />}>
          <Route path="/onboarding" element={<OnboardingPage />} />

          <Route element={<RequireOnboarding />}>
            <Route element={<CRMLayout />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/channels" element={<ChannelsPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route
                path="/contacts"
                element={
                  <PlaceholderPage
                    title="Contacts"
                    description="View and manage your contacts."
                    icon={Users}
                  />
                }
              />
              <Route path="/ai-config" element={<AIConfigPage />} />
              <Route
                path="/chatbot-control"
                element={
                  <PlaceholderPage
                    title="Chatbot Control"
                    description="Control your chatbot settings and responses."
                    icon={Bot}
                  />
                }
              />
              <Route
                path="/statistics"
                element={
                  <PlaceholderPage
                    title="Statistics"
                    description="View analytics and performance metrics."
                    icon={BarChart3}
                  />
                }
              />
              <Route
                path="/feedback"
                element={
                  <PlaceholderPage
                    title="Feedback"
                    description="Review customer feedback and ratings."
                    icon={MessageSquareHeart}
                  />
                }
              />
              <Route path="/business" element={<BusinessPage />} />
              <Route path="/profile" element={<ProfilePage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
