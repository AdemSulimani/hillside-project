import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, Building2, Upload, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import { cn, assetUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApiResponse, Tenant } from '@/types';

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

interface BusinessFieldErrors {
  name?: string[];
  niche?: string[];
  description?: string[];
  delivery_methods?: string[];
}

const selectClasses =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

function extractFieldErrors(err: unknown): BusinessFieldErrors | null {
  if (err instanceof AxiosError && err.response) {
    const { status, data } = err.response;
    if ((status === 400 || status === 422) && data?.error) {
      return (typeof data.error === 'object' ? data.error.body ?? data.error : {}) as BusinessFieldErrors;
    }
  }
  return null;
}

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return err.response.data.message;
  }
  return fallback;
}

export default function BusinessPage() {
  const queryClient = useQueryClient();
  const setTenant = useAuthStore((s) => s.setTenant);

  const [name, setName] = useState('');
  const [niche, setNiche] = useState('');
  const [description, setDescription] = useState('');
  const [deliveryMethods, setDeliveryMethods] = useState<string[]>([]);
  const [errors, setErrors] = useState<BusinessFieldErrors>({});
  const [generalError, setGeneralError] = useState('');

  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: business, isLoading } = useQuery({
    queryKey: ['business'],
    queryFn: async () => {
      const { data } = await api.get<ApiResponse<{ business: Tenant }>>('/business');
      return data.data!.business;
    },
  });

  useEffect(() => {
    if (business) {
      setName(business.name);
      setNiche(business.niche);
      setDescription(business.description ?? '');
      setDeliveryMethods(business.delivery_methods);
      setLogoPreview(assetUrl(business.logo_url) ?? null);
    }
  }, [business]);

  const updateMutation = useMutation({
    mutationFn: async (payload: {
      name: string;
      niche: string;
      description: string | null;
      delivery_methods: string[];
    }) => {
      const { data } = await api.put<ApiResponse<{ business: Tenant }>>('/business', payload);
      return data.data!.business;
    },
    onSuccess: (updated) => {
      setTenant(updated);
      setErrors({});
      setGeneralError('');
      queryClient.invalidateQueries({ queryKey: ['business'] });
      toast.success('Business details updated successfully');
    },
    onError: (err) => {
      const fieldErrors = extractFieldErrors(err);
      if (fieldErrors) {
        setErrors(fieldErrors);
        setGeneralError('');
      } else {
        setErrors({});
        setGeneralError(extractMessage(err, 'Failed to update business details'));
      }
    },
  });

  const logoMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('logo', file);
      const { data } = await api.post<ApiResponse<{ logo_url: string }>>(
        '/business/logo',
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      return data.data!.logo_url;
    },
    onSuccess: (logoUrl) => {
      setLogoPreview(assetUrl(logoUrl) ?? null);
      queryClient.invalidateQueries({ queryKey: ['business'] });
      toast.success('Logo uploaded successfully');
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Failed to upload logo'));
    },
  });

  function handleDeliveryToggle(method: string) {
    setDeliveryMethods((prev) =>
      prev.includes(method) ? prev.filter((m) => m !== method) : [...prev, method],
    );
    setErrors((prev) => {
      if (!prev.delivery_methods) return prev;
      const next = { ...prev };
      delete next.delivery_methods;
      return next;
    });
  }

  function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo must be under 2 MB');
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      toast.error('Only JPEG, PNG, WebP, or SVG allowed');
      return;
    }

    setLogoPreview(URL.createObjectURL(file));
    logoMutation.mutate(file);

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setGeneralError('');
    updateMutation.mutate({
      name: name.trim(),
      niche,
      description: description.trim() || null,
      delivery_methods: deliveryMethods,
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Skeleton className="h-96 w-full rounded-xl" />
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Business</h1>
        <p className="text-sm text-muted-foreground">
          Manage your business details and branding.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Business Details Form */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Building2 className="size-5 text-muted-foreground" />
              <CardTitle>Business Details</CardTitle>
            </div>
            <CardDescription>Update your business information.</CardDescription>
          </CardHeader>
          <CardContent>
            {generalError && (
              <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {generalError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="businessName">Business Name</Label>
                  <Input
                    id="businessName"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme Corp"
                    aria-invalid={!!errors.name}
                    className="h-10"
                  />
                  {errors.name?.map((msg) => (
                    <p key={msg} className="text-xs text-destructive">{msg}</p>
                  ))}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="niche">Industry / Niche</Label>
                  <select
                    id="niche"
                    value={niche}
                    onChange={(e) => setNiche(e.target.value)}
                    aria-invalid={!!errors.niche}
                    className={selectClasses}
                  >
                    <option value="" disabled>Select a niche</option>
                    {NICHES.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                  {errors.niche?.map((msg) => (
                    <p key={msg} className="text-xs text-destructive">{msg}</p>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">
                  Description{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Tell us a bit about what your business does..."
                  rows={4}
                  className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                {errors.description?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </div>

              <fieldset className="space-y-3">
                <legend className="flex items-center gap-2 text-sm font-medium leading-none select-none">
                  Delivery Methods
                </legend>
                <div className="grid grid-cols-2 gap-3">
                  {DELIVERY_METHODS.map((method) => {
                    const checked = deliveryMethods.includes(method);
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
                {errors.delivery_methods?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </fieldset>

              <div className="pt-2">
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending && <Loader2 className="animate-spin" />}
                  {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Logo Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ImageIcon className="size-5 text-muted-foreground" />
              <CardTitle>Logo</CardTitle>
            </div>
            <CardDescription>Upload your business logo.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {logoPreview ? (
              <div className="relative inline-block">
                <img
                  src={logoPreview}
                  alt="Business logo"
                  className="size-32 rounded-lg border object-cover"
                  loading="lazy"
                  decoding="async"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Change logo"
                  className="absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/80"
                >
                  <Upload className="size-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={logoMutation.isPending}
                className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 px-6 py-8 text-sm text-muted-foreground transition-colors hover:border-ring/50 hover:text-foreground"
              >
                <Upload className="size-8 opacity-50" />
                <span>Click to upload</span>
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

            {logoMutation.isPending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Uploading…
              </div>
            )}

            {logoPreview && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={logoMutation.isPending}
              >
                <Upload className="size-4" />
                Change Logo
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
