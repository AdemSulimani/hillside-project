import { Routes, Route } from 'react-router-dom';
import HomePage from '@/pages/Home';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';
import RequireOnboarding from '@/components/auth/RequireOnboarding';

function DashboardPlaceholder() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-medium">Dashboard (coming soon)</h1>
    </div>
  );
}

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
          <Route path="/dashboard" element={<DashboardPlaceholder />} />
        </Route>
      </Route>
    </Routes>
  );
}
