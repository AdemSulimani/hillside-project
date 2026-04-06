import { useState, useRef, type ChangeEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import StepIndicator from '@/components/onboarding/StepIndicator';
import type { ApiResponse, User, Tenant } from '@/types';

const STEPS = [
  { label: 'Business' },
  { label: 'Details' },
  { label: 'Review' },
];

const NICHES = [
  'E-commerce',
  'Services',
];

const DELIVERY_METHODS = [
  'Home Delivery',
  'Store Pickup',
  'Courier',
  'Digital',
];

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
    if (!form.name.trim()) errors.name = 'Business name is required';
    if (!form.niche) errors.niche = 'Please select a niche';
  }

  if (step === 2) {
    if (form.deliveryMethods.length === 0) {
      errors.deliveryMethods = 'Select at least one delivery method';
    }
  }

  return errors;
}

const selectClasses =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

export default function OnboardingPage() {
  const navigate = useNavigate();
  const isOnboarded = useAuthStore((s) => s.isOnboarded);
  const { setUser, setTenant, setOnboarded } = useAuthStore();

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

  function handleDeliveryToggle(method: string) {
    setForm((prev) => {
      const exists = prev.deliveryMethods.includes(method);
      return {
        ...prev,
        deliveryMethods: exists
          ? prev.deliveryMethods.filter((m) => m !== method)
          : [...prev.deliveryMethods, method],
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
      setErrors((prev) => ({ ...prev, logo: 'Logo must be under 2 MB' }));
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      setErrors((prev) => ({ ...prev, logo: 'Only JPEG, PNG, WebP, or SVG allowed' }));
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

      const { data } = await api.post<ApiResponse<{ user: User; tenant: Tenant }>>(
        '/onboarding/complete',
        body,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );

      const result = data.data!;
      setUser(result.user);
      setTenant(result.tenant);
      setOnboarded(true);
      toast.success('Business setup complete!');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof AxiosError && err.response) {
        const { status, data } = err.response;
        if (status === 400 && data?.error) {
          const fieldErrors =
            typeof data.error === 'object' ? data.error : {};
          setErrors(fieldErrors);
        } else if (status === 409) {
          setGeneralError(data?.message ?? 'Onboarding was already completed.');
        } else {
          setGeneralError(data?.message ?? 'Something went wrong. Please try again.');
        }
      } else {
        setGeneralError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your business</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tell us about your business so we can tailor the experience for you.
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
                <Label htmlFor="name">Business name</Label>
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
                <Label htmlFor="niche">Industry / Niche</Label>
                <select
                  id="niche"
                  value={form.niche}
                  onChange={(e) => updateField('niche', e.target.value)}
                  aria-invalid={!!errors.niche}
                  className={selectClasses}
                >
                  <option value="" disabled>Select a niche</option>
                  {NICHES.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                {errors.niche && <p className="text-xs text-destructive">{errors.niche}</p>}
              </div>

            </>
          )}

          {step === 2 && (
            <>
              <div className="space-y-2">
                <Label htmlFor="description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <textarea
                  id="description"
                  value={form.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Tell us a bit about what your business does..."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>

              <fieldset className="space-y-3">
                <legend className="flex items-center gap-2 text-sm font-medium leading-none select-none">
                  Delivery methods
                </legend>
                <div className="grid grid-cols-2 gap-3">
                  {DELIVERY_METHODS.map((method) => {
                    const checked = form.deliveryMethods.includes(method);
                    return (
                      <label
                        key={method}
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
                          onChange={() => handleDeliveryToggle(method)}
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
                        {method}
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
                <Label>Logo <span className="font-normal text-muted-foreground">(optional)</span></Label>
                {logoPreview ? (
                  <div className="relative inline-block">
                    <img
                      src={logoPreview}
                      alt="Logo preview"
                      className="size-24 rounded-lg border object-cover"
                    />
                    <button
                      type="button"
                      onClick={removeLogo}
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
                    <span>Click to upload your logo</span>
                    <span className="text-xs opacity-60">JPEG, PNG, WebP or SVG — max 2 MB</span>
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
                <h3 className="text-sm font-semibold">Review your details</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Business name</dt>
                  <dd>{form.name}</dd>
                  <dt className="text-muted-foreground">Niche</dt>
                  <dd>{form.niche}</dd>
                  {form.description.trim() && (
                    <>
                      <dt className="text-muted-foreground">Description</dt>
                      <dd className="line-clamp-3">{form.description}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Delivery</dt>
                  <dd>{form.deliveryMethods.join(', ')}</dd>
                </dl>
              </div>
            </>
          )}

          <div className="flex items-center justify-between pt-2">
            {step > 1 ? (
              <Button variant="outline" size="lg" onClick={goBack} disabled={loading}>
                Back
              </Button>
            ) : (
              <span />
            )}

            {step < 3 ? (
              <Button size="lg" onClick={goNext}>
                Continue
              </Button>
            ) : (
              <Button size="lg" onClick={handleSubmit} disabled={loading}>
                {loading && <Loader2 className="animate-spin" />}
                {loading ? 'Setting up…' : 'Complete setup'}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
