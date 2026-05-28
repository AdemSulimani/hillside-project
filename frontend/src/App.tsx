import { Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import AdminProtectedRoute from '@/components/auth/AdminProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';
import RequireOnboarding from '@/components/auth/RequireOnboarding';
import CRMLayout from '@/components/layouts/CRMLayout';
import AdminLayout from '@/components/layouts/AdminLayout';
import { FullPageRouteFallback } from '@/components/layouts/RouteFallback';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
const PrivacyPolicyPage = lazyWithRetry(() => import('@/pages/legal/PrivacyPolicyPage'), 'PrivacyPolicyPage');
const TermsOfServicePage = lazyWithRetry(() => import('@/pages/legal/TermsOfServicePage'), 'TermsOfServicePage');
const DataDeletionRequestPage = lazyWithRetry(() => import('@/pages/legal/DataDeletionRequestPage'), 'DataDeletionRequestPage');
const LoginPage = lazyWithRetry(() => import('@/pages/auth/LoginPage'), 'LoginPage');
const RegisterPage = lazyWithRetry(() => import('@/pages/auth/RegisterPage'), 'RegisterPage');
const OnboardingPage = lazyWithRetry(() => import('@/pages/onboarding/OnboardingPage'), 'OnboardingPage');
const DashboardPage = lazyWithRetry(() => import('@/pages/dashboard/DashboardPage'), 'DashboardPage');
const ProfilePage = lazyWithRetry(() => import('@/pages/profile/ProfilePage'), 'ProfilePage');
const BusinessPage = lazyWithRetry(() => import('@/pages/business/BusinessPage'), 'BusinessPage');
const ProductsPage = lazyWithRetry(() => import('@/pages/products/ProductsPage'), 'ProductsPage');
const ChannelsPage = lazyWithRetry(() => import('@/pages/channels/ChannelsPage'), 'ChannelsPage');
const InboxPage = lazyWithRetry(() => import('@/pages/inbox/InboxPage'), 'InboxPage');
const OrdersPage = lazyWithRetry(() => import('@/pages/orders/OrdersPage'), 'OrdersPage');
const ContactsPage = lazyWithRetry(() => import('@/pages/contacts/ContactsPage'), 'ContactsPage');
const ContactDetailPage = lazyWithRetry(() => import('@/pages/contacts/ContactDetailPage'), 'ContactDetailPage');
const FeedbackPage = lazyWithRetry(() => import('@/pages/feedback/FeedbackPage'), 'FeedbackPage');
const AIAlertsPage = lazyWithRetry(() => import('@/pages/aiAlerts/AIAlertsPage'), 'AIAlertsPage');
const StatisticsPage = lazyWithRetry(() => import('@/pages/statistics/StatisticsPage'), 'StatisticsPage');
const ChatbotControlPage = lazyWithRetry(() => import('@/pages/chatbotControl/ChatbotControlPage'), 'ChatbotControlPage');
const AdminLoginPage = lazyWithRetry(() => import('@/pages/admin/AdminLoginPage'), 'AdminLoginPage');
const AdminDashboardPage = lazyWithRetry(() => import('@/pages/admin/AdminDashboardPage'), 'AdminDashboardPage');
const AdminBusinessesPage = lazyWithRetry(() => import('@/pages/admin/AdminBusinessesPage'), 'AdminBusinessesPage');
const AdminBusinessDetailPage = lazyWithRetry(() => import('@/pages/admin/AdminBusinessDetailPage'), 'AdminBusinessDetailPage');
const AdminCommissionReportsPage = lazyWithRetry(() => import('@/pages/admin/AdminCommissionReportsPage'), 'AdminCommissionReportsPage');
const AdminAiCatalogPage = lazyWithRetry(() => import('@/pages/admin/AdminAiCatalogPage'), 'AdminAiCatalogPage');
const CreditsPage = lazyWithRetry(() => import('@/pages/credits/CreditsPage'), 'CreditsPage');

export default function App() {
  return (
    <Suspense fallback={<FullPageRouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
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
            <Route path="ai-catalog" element={<AdminAiCatalogPage />} />
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
              <Route path="/ai-config" element={<Navigate to="/statistics" replace />} />
              <Route path="/chatbot-control" element={<ChatbotControlPage />} />
              <Route path="/statistics" element={<StatisticsPage />} />
              <Route path="/feedback" element={<FeedbackPage />} />
              <Route path="/ai-alerts" element={<AIAlertsPage />} />
              <Route path="/credits" element={<CreditsPage />} />
              <Route path="/business" element={<BusinessPage />} />
              <Route path="/profile" element={<ProfilePage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}
