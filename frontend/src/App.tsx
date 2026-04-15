import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import AdminProtectedRoute from '@/components/auth/AdminProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';
import RequireOnboarding from '@/components/auth/RequireOnboarding';
import CRMLayout from '@/components/layouts/CRMLayout';
import AdminLayout from '@/components/layouts/AdminLayout';
import { FullPageRouteFallback } from '@/components/layouts/RouteFallback';
const HomePage = lazy(() => import('@/pages/Home'));
const PrivacyPolicyPage = lazy(() => import('@/pages/legal/PrivacyPolicyPage'));
const TermsOfServicePage = lazy(() => import('@/pages/legal/TermsOfServicePage'));
const DataDeletionRequestPage = lazy(() => import('@/pages/legal/DataDeletionRequestPage'));
const LoginPage = lazy(() => import('@/pages/auth/LoginPage'));
const RegisterPage = lazy(() => import('@/pages/auth/RegisterPage'));
const OnboardingPage = lazy(() => import('@/pages/onboarding/OnboardingPage'));
const DashboardPage = lazy(() => import('@/pages/dashboard/DashboardPage'));
const ProfilePage = lazy(() => import('@/pages/profile/ProfilePage'));
const BusinessPage = lazy(() => import('@/pages/business/BusinessPage'));
const ProductsPage = lazy(() => import('@/pages/products/ProductsPage'));
const ChannelsPage = lazy(() => import('@/pages/channels/ChannelsPage'));
const InboxPage = lazy(() => import('@/pages/inbox/InboxPage'));
const AIConfigPage = lazy(() => import('@/pages/aiConfig/AIConfigPage'));
const OrdersPage = lazy(() => import('@/pages/orders/OrdersPage'));
const ContactsPage = lazy(() => import('@/pages/contacts/ContactsPage'));
const ContactDetailPage = lazy(() => import('@/pages/contacts/ContactDetailPage'));
const FeedbackPage = lazy(() => import('@/pages/feedback/FeedbackPage'));
const AIAlertsPage = lazy(() => import('@/pages/aiAlerts/AIAlertsPage'));
const StatisticsPage = lazy(() => import('@/pages/statistics/StatisticsPage'));
const ChatbotControlPage = lazy(() => import('@/pages/chatbotControl/ChatbotControlPage'));
const AdminLoginPage = lazy(() => import('@/pages/admin/AdminLoginPage'));
const AdminDashboardPage = lazy(() => import('@/pages/admin/AdminDashboardPage'));
const AdminBusinessesPage = lazy(() => import('@/pages/admin/AdminBusinessesPage'));
const AdminBusinessDetailPage = lazy(() => import('@/pages/admin/AdminBusinessDetailPage'));
const AdminCommissionReportsPage = lazy(() => import('@/pages/admin/AdminCommissionReportsPage'));

export default function App() {
  return (
    <Suspense fallback={<FullPageRouteFallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
        <Route path="/terms-of-service" element={<TermsOfServicePage />} />
        <Route path="/data-deletion" element={<DataDeletionRequestPage />} />

        <Route path="/admin/login" element={<AdminLoginPage />} />

        <Route element={<AdminProtectedRoute />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="businesses" element={<AdminBusinessesPage />} />
            <Route path="businesses/:tenantId" element={<AdminBusinessDetailPage />} />
            <Route path="commission-reports" element={<AdminCommissionReportsPage />} />
          </Route>
        </Route>

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
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/contacts/:id" element={<ContactDetailPage />} />
              <Route path="/ai-config" element={<AIConfigPage />} />
              <Route path="/chatbot-control" element={<ChatbotControlPage />} />
              <Route path="/statistics" element={<StatisticsPage />} />
              <Route path="/feedback" element={<FeedbackPage />} />
              <Route path="/ai-alerts" element={<AIAlertsPage />} />
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
