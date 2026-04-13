import { useState, type FormEvent, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { adminLogin } from '@/api/platformAdminApi';
import { useAdminAuthStore } from '@/store/adminAuthStore';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function AdminLoginPage() {
  const navigate = useNavigate();
  const isAuthenticated = useAdminAuthStore((s) => s.isAuthenticated);
  const setAuth = useAdminAuthStore((s) => s.setAuth);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [generalError, setGeneralError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = 'Platform Admin — Hillside';
  }, []);

  if (isAuthenticated) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setGeneralError('');
    setLoading(true);

    try {
      const { accessToken, owner } = await adminLogin(email.trim(), password);
      setAuth(accessToken, owner);
      toast.success('Signed in to platform admin');
      navigate('/admin/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof AxiosError && err.response?.data?.message) {
        setGeneralError(String(err.response.data.message));
      } else {
        setGeneralError('Sign-in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Platform admin</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your platform owner account (separate from business CRM login).
          </p>
        </div>

        {generalError ? (
          <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{generalError}</div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="admin-email">Email</Label>
            <Input
              id="admin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              className="h-10"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-password">Password</Label>
            <PasswordInput
              id="admin-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
