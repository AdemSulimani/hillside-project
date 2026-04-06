import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from '@/pages/Home';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';
import RequireOnboarding from '@/components/auth/RequireOnboarding';
import CRMLayout from '@/components/layouts/CRMLayout';
import DashboardPage from '@/pages/dashboard/DashboardPage';
import ProfilePage from '@/pages/profile/ProfilePage';
import BusinessPage from '@/pages/business/BusinessPage';
import PlaceholderPage from '@/pages/crm/PlaceholderPage';
import {
  Inbox,
  Package,
  Radio,
  ShoppingCart,
  Users,
  BrainCircuit,
  Bot,
  BarChart3,
  MessageSquareHeart,
} from 'lucide-react';

export default function App() {
  return (
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
            <Route path="/inbox" element={<PlaceholderPage title="Inbox" description="Manage your conversations across all channels." icon={Inbox} />} />
            <Route path="/products" element={<PlaceholderPage title="Products" description="Manage your product catalog." icon={Package} />} />
            <Route path="/channels" element={<PlaceholderPage title="Channels" description="Connect and manage your messaging channels." icon={Radio} />} />
            <Route path="/orders" element={<PlaceholderPage title="Orders" description="Track and manage customer orders." icon={ShoppingCart} />} />
            <Route path="/contacts" element={<PlaceholderPage title="Contacts" description="View and manage your contacts." icon={Users} />} />
            <Route path="/ai-config" element={<PlaceholderPage title="AI Config" description="Configure your AI assistant behavior." icon={BrainCircuit} />} />
            <Route path="/chatbot-control" element={<PlaceholderPage title="Chatbot Control" description="Control your chatbot settings and responses." icon={Bot} />} />
            <Route path="/statistics" element={<PlaceholderPage title="Statistics" description="View analytics and performance metrics." icon={BarChart3} />} />
            <Route path="/feedback" element={<PlaceholderPage title="Feedback" description="Review customer feedback and ratings." icon={MessageSquareHeart} />} />
            <Route path="/business" element={<BusinessPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
