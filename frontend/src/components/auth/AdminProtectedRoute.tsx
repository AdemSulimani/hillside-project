import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAdminAuthStore } from '@/store/adminAuthStore';

export default function AdminProtectedRoute() {
  const token = useAdminAuthStore((s) => s.accessToken);
  const location = useLocation();

  if (!token) {
    return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
