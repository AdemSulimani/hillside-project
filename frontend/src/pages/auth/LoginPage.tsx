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
  email?: string[];
  password?: string[];
}

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setGeneralError('');
    setLoading(true);

    try {
      await login(email, password, rememberMe);
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        const status = err.response.status;
        const data = err.response.data;

        if ((status === 400 || status === 422) && data?.error) {
          const fieldErrors =
            typeof data.error === 'object' ? data.error.body ?? data.error : {};
          setErrors(fieldErrors);
        } else {
          setGeneralError(data?.message ?? 'Hyrja dështoi. Ju lutemi provoni përsëri.');
        }
      } else {
        setGeneralError('Ndodhi një gabim i papritur.');
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
            &quot;Hillside e ka transformuar plotësisht mënyrën se si e menaxhojmë punën tonë.&quot;
          </p>
          <p className="text-sm opacity-80">— Klient i kënaqur</p>
        </div>
        <p className="text-xs opacity-60">&copy; {new Date().getFullYear()} Hillside. Të gjitha të drejtat e rezervuara.</p>
      </div>

      {/* Right — Form */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight lg:hidden">Hillside</h1>
            <h2 className="text-2xl font-semibold tracking-tight">Mirë se erdhe përsëri</h2>
            <p className="text-sm text-muted-foreground">
              Vendos kredencialet për t&apos;u futur
            </p>
          </div>

          {generalError && (
            <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {generalError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ju@shembull.com"
                aria-invalid={!!errors.email}
                className="h-10"
                required
              />
              {errors.email?.map((msg) => (
                <p key={msg} className="text-xs text-destructive">{msg}</p>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Fjalëkalimi</Label>
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Fjalëkalimi juaj"
                aria-invalid={!!errors.password}
                required
              />
              {errors.password?.map((msg) => (
                <p key={msg} className="text-xs text-destructive">{msg}</p>
              ))}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Mbaj mend për 30 ditë
            </label>

            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              {loading ? 'Duke u futur…' : 'Hyr'}
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            Nuk keni llogari?{' '}
            <Link to="/register" className="font-medium text-primary hover:underline">
              Krijoni një
            </Link>
          </p>

          <p className="text-center text-xs text-muted-foreground">
            Duke vazhduar, pranoni{' '}
            <Link to="/terms-of-service" className="hover:text-foreground hover:underline">
              Kushtet e shërbimit
            </Link>{' '}
            dhe{' '}
            <Link to="/privacy-policy" className="hover:text-foreground hover:underline">
              Politikën e privatësisë
            </Link>
            .
          </p>

          <p className="text-center text-xs text-muted-foreground">
            <Link to="/data-deletion" className="hover:text-foreground hover:underline">
              Kërkesat për fshirje të dhënash
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
