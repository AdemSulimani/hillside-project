import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FieldErrors {
  name?: string[];
  email?: string[];
  password?: string[];
  confirmPassword?: string;
}

export default function RegisterPage() {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setGeneralError('');

    if (password !== confirmPassword) {
      setErrors({ confirmPassword: 'Passwords do not match' });
      return;
    }

    setLoading(true);
    try {
      await register(name, email, password, rememberMe);
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        const status = err.response.status;
        const data = err.response.data;

        if (status === 409) {
          setErrors({ email: ['This email is already registered'] });
        } else if ((status === 400 || status === 422) && data?.error) {
          const fieldErrors =
            typeof data.error === 'object' ? data.error.body ?? data.error : {};
          setErrors(fieldErrors);
        } else {
          setGeneralError(data?.message ?? 'Registration failed. Please try again.');
        }
      } else {
        setGeneralError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left — Branded panel */}
      <div className="hidden lg:flex flex-col justify-between bg-primary p-10 text-primary-foreground">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Hillside</h1>
        </div>
        <div className="space-y-2">
          <p className="text-lg font-medium leading-snug">
            "Getting started was incredibly easy. We were up and running in minutes."
          </p>
          <p className="text-sm opacity-80">— Early adopter</p>
        </div>
        <p className="text-xs opacity-60">&copy; {new Date().getFullYear()} Hillside. All rights reserved.</p>
      </div>

      {/* Right — Form */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight lg:hidden">Hillside</h1>
            <h2 className="text-2xl font-semibold tracking-tight">Create an account</h2>
            <p className="text-sm text-muted-foreground">
              Enter your details to get started
            </p>
          </div>

          {generalError && (
            <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {generalError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Doe"
                aria-invalid={!!errors.name}
                className="h-10"
                required
              />
              {errors.name?.map((msg) => (
                <p key={msg} className="text-xs text-destructive">{msg}</p>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-invalid={!!errors.email}
                className="h-10"
                required
              />
              {errors.email?.map((msg) => (
                <p key={msg} className="text-xs text-destructive">{msg}</p>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8+ characters"
                  aria-invalid={!!errors.password}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm</Label>
                <PasswordInput
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat"
                  aria-invalid={!!errors.confirmPassword}
                  required
                />
              </div>
            </div>
            {errors.password?.map((msg) => (
              <p key={msg} className="text-xs text-destructive">{msg}</p>
            ))}
            {errors.confirmPassword && (
              <p className="text-xs text-destructive">{errors.confirmPassword}</p>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Remember me for 30 days
            </label>

            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              {loading ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>

          <p className="text-center text-xs text-muted-foreground">
            By creating an account, you agree to our{' '}
            <Link to="/terms-of-service" className="hover:text-foreground hover:underline">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link to="/privacy-policy" className="hover:text-foreground hover:underline">
              Privacy Policy
            </Link>
            .
          </p>

          <p className="text-center text-xs text-muted-foreground">
            <Link to="/data-deletion" className="hover:text-foreground hover:underline">
              Data deletion requests
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
