import { useState, useRef, type ChangeEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/authStore';
import { queryClient } from '@/lib/query-client';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import StepIndicator from '@/components/onboarding/StepIndicator';
import type { ApiResponse, User, Tenant } from '@/types';

const STEPS = [{ label: 'Biznesi' }, { label: 'Detajet' }, { label: 'Rishikimi' }];

const NICHE_OPTIONS = [
  { value: 'E-commerce', label: 'E-tregti' },
  { value: 'Services', label: 'Shërbime' },
] as const;

const DELIVERY_OPTIONS = [
  { value: 'Home Delivery', label: 'Dërgesë në shtëpi' },
  { value: 'Store Pickup', label: 'Marrje në dyqan' },
  { value: 'Courier', label: 'Kurier' },
  { value: 'Digital', label: 'Dixhital' },
] as const;

function nicheLabel(value: string): string {
  return NICHE_OPTIONS.find((n) => n.value === value)?.label ?? value;
}

function deliveryLabels(values: string[]): string {
  return values
    .map((v) => DELIVERY_OPTIONS.find((d) => d.value === v)?.label ?? v)
    .join(', ');
}

interface OnboardingForm {
  name: string;
  niche: string;
  description: string;
  deliveryMethods: string[];
  logo: File | null;
}

const INITIAL_FORM: OnboardingForm = {
  name: '',
  niche: '',
  description: '',
  deliveryMethods: [],
  logo: null,
};

type FieldErrors = Partial<Record<keyof OnboardingForm, string>>;

function validateStep(step: number, form: OnboardingForm): FieldErrors {
  const errors: FieldErrors = {};

  if (step === 1) {
    if (!form.name.trim()) errors.name = 'Emri i biznesit është i detyrueshëm';
    if (!form.niche) errors.niche = 'Ju lutemi zgjidhni një niç';
  }

  if (step === 2) {
    if (form.deliveryMethods.length === 0) {
      errors.deliveryMethods = 'Zgjidhni të paktën një mënyrë dërgimi';
    }
  }

  return errors;
}

const selectClasses =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

export default function OnboardingPage() {
  const navigate = useNavigate();
  const isOnboarded = useAuthStore((s) => s.isOnboarded);
  const { setUser, setTenant, setOnboarded, setAccessToken } = useAuthStore();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState<OnboardingForm>(INITIAL_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState('');
  const [loading, setLoading] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (isOnboarded) {
    return <Navigate to="/dashboard" replace />;
  }

  function updateField<K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function handleDeliveryToggle(methodValue: string) {
    setForm((prev) => {
      const exists = prev.deliveryMethods.includes(methodValue);
      return {
        ...prev,
        deliveryMethods: exists
          ? prev.deliveryMethods.filter((m) => m !== methodValue)
          : [...prev.deliveryMethods, methodValue],
      };
    });
    setErrors((prev) => {
      if (!prev.deliveryMethods) return prev;
      const next = { ...prev };
      delete next.deliveryMethods;
      return next;
    });
  }

  function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setErrors((prev) => ({ ...prev, logo: 'Logoja duhet të jetë nën 2 MB' }));
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      setErrors((prev) => ({ ...prev, logo: 'Lejohen vetëm JPEG, PNG, WebP ose SVG' }));
      return;
    }

    updateField('logo', file);
    setLogoPreview(URL.createObjectURL(file));
  }

  function removeLogo() {
    updateField('logo', null);
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    setLogoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function goNext() {
    const stepErrors = validateStep(step, form);
    if (Object.keys(stepErrors).length > 0) {
      setErrors(stepErrors);
      return;
    }
    setErrors({});
    setStep((s) => s + 1);
  }

  function goBack() {
    setErrors({});
    setStep((s) => s - 1);
  }

  async function handleSubmit() {
    setGeneralError('');
    setLoading(true);

    try {
      const body = new globalThis.FormData();
      body.append('name', form.name.trim());
      body.append('niche', form.niche);
      if (form.description.trim()) body.append('description', form.description.trim());
      form.deliveryMethods.forEach((m) => body.append('delivery_methods[]', m));
      if (form.logo) body.append('logo', form.logo);

      const { data } = await api.post<
        ApiResponse<{ user: User; tenant: Tenant; accessToken: string }>
      >('/onboarding/complete', body);

      const result = data.data!;
      queryClient.clear();
      setAccessToken(result.accessToken);
      setUser(result.user);
      setTenant(result.tenant);
      setOnboarded(true);
      toast.success('Konfigurimi i biznesit u përfundua!');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        const { status, data } = err.response;
        if (status === 400 && data?.error) {
          const fieldErrors =
            typeof data.error === 'object' ? data.error : {};
          setErrors(fieldErrors);
        } else if (status === 409) {
          setGeneralError(data?.message ?? 'Konfigurimi i biznesit ishte përfunduar më parë.');
        } else {
          setGeneralError(data?.message ?? 'Diçka shkoi keq. Ju lutemi provoni përsëri.');
        }
      } else {
        setGeneralError('Ndodhi një gabim i papritur.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Konfiguro biznesin tënd</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Na trego për biznesin tënd që ta përshtasim përvojën për ty.
        </p>
      </div>

      <StepIndicator steps={STEPS} currentStep={step} />

      <Card className="mt-8 w-full max-w-lg">
        <CardContent className="space-y-5 pt-2">
          {generalError && (
            <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {generalError}
            </div>
          )}

          {step === 1 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="name">Emri i biznesit</Label>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="Acme Corp"
                  aria-invalid={!!errors.name}
                  className="h-10"
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>

              <div className="space-y-2">
                <Label htmlFor="niche">Industria / Niçi</Label>
                <select
                  id="niche"
                  value={form.niche}
                  onChange={(e) => updateField('niche', e.target.value)}
                  aria-invalid={!!errors.niche}
                  className={selectClasses}
                >
                  <option value="" disabled>Zgjidhni një niç</option>
                  {NICHE_OPTIONS.map((n) => (
                    <option key={n.value} value={n.value}>
                      {n.label}
                    </option>
                  ))}
                </select>
                {errors.niche && <p className="text-xs text-destructive">{errors.niche}</p>}
              </div>

            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="description">Përshkrimi <span className="font-normal text-muted-foreground">(opsional)</span></Label>
                <textarea
                  id="description"
                  value={form.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Na trego pak çfarë bën biznesi yt..."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>

              <fieldset className="space-y-3">
                <legend className="flex items-center gap-2 text-sm font-medium leading-none select-none">
                  Mënyrat e dërgimit
                </legend>
                <div className="grid grid-cols-2 gap-3">
                  {DELIVERY_OPTIONS.map(({ value: methodValue, label: methodLabel }) => {
                    const checked = form.deliveryMethods.includes(methodValue);
                    return (
                      <label
                        key={methodValue}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-colors',
                          checked
                            ? 'border-primary bg-primary/5 text-foreground'
                            : 'border-input text-muted-foreground hover:border-ring/40',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleDeliveryToggle(methodValue)}
                          className="sr-only"
                        />
                        <div
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-muted-foreground/40',
                          )}
                        >
                          {checked && (
                            <svg className="size-3" viewBox="0 0 12 12" fill="none">
                              <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        {methodLabel}
                      </label>
                    );
                  })}
                </div>
                {errors.deliveryMethods && (
                  <p className="text-xs text-destructive">{errors.deliveryMethods}</p>
                )}
              </fieldset>
            </>
          )}

          {step === 3 && (
            <>
              <div className="space-y-2">
                <Label>Logoja <span className="font-normal text-muted-foreground">(opsional)</span></Label>
                {logoPreview ? (
                  <div className="relative inline-block">
                    <img
                      src={logoPreview}
                      alt="Parapamje e logos"
                      className="size-24 rounded-lg border object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                    <button
                      type="button"
                      onClick={removeLogo}
                      aria-label="Hiq logon"
                      className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-destructive text-white shadow-sm transition-colors hover:bg-destructive/80"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 px-6 py-8 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
                  >
                    <Upload className="size-8 opacity-50" />
                    <span>Kliko për të ngarkuar logon</span>
                    <span className="text-xs opacity-60">JPEG, PNG, WebP ose SVG — maks. 2 MB</span>
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/svg+xml"
                  onChange={handleLogoChange}
                  className="hidden"
                />
                {errors.logo && <p className="text-xs text-destructive">{errors.logo}</p>}
              </div>

              <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                <h3 className="text-sm font-semibold">Rishiko të dhënat</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Emri i biznesit</dt>
                  <dd>{form.name}</dd>
                  <dt className="text-muted-foreground">Niçi</dt>
                  <dd>{nicheLabel(form.niche)}</dd>
                  {form.description.trim() && (
                    <>
                      <dt className="text-muted-foreground">Përshkrimi</dt>
                      <dd className="line-clamp-3">{form.description}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Dërgimi</dt>
                  <dd>{deliveryLabels(form.deliveryMethods)}</dd>
                </dl>
              </div>
            </>
          )}

          <div className="flex items-center justify-between pt-2">
            {step > 1 ? (
              <Button variant="outline" size="lg" onClick={goBack} disabled={loading}>
                Prapa
              </Button>
            ) : (
              <span />
            )}

            {step < 3 ? (
              <Button size="lg" onClick={goNext}>
                Vazhdo
              </Button>
            ) : (
              <Button size="lg" onClick={handleSubmit} disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                {loading ? 'Duke konfiguruar…' : 'Përfundo konfigurimin'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
