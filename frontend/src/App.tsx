import { Routes, Route } from 'react-router-dom';
import HomePage from '@/pages/Home';
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import PublicOnlyRoute from '@/components/auth/PublicOnlyRoute';

function DashboardPlaceholder() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-medium">Dashboard (coming soon)</h1>
    </div>
  );
}

function OnboardingPlaceholder() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-medium">Onboarding (coming soon)</h1>
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
        <Route path="/dashboard" element={<DashboardPlaceholder />} />
        <Route path="/onboarding" element={<OnboardingPlaceholder />} />
      </Route>
    </Routes>
  );
}
