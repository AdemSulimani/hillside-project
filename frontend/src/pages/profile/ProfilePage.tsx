import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, UserCircle, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { ApiResponse, User } from '@/types';

interface ProfileFieldErrors {
  name?: string[];
  email?: string[];
}

interface PasswordFieldErrors {
  currentPassword?: string[];
  newPassword?: string[];
  confirmPassword?: string[];
}

function extractFieldErrors<T>(err: unknown): T | null {
  if (err instanceof AxiosError && err.response) {
    const { status, data } = err.response;
    if ((status === 400 || status === 422) && data?.error) {
      return (typeof data.error === 'object' ? data.error.body ?? data.error : {}) as T;
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

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileErrors, setProfileErrors] = useState<ProfileFieldErrors>({});
  const [profileGeneralError, setProfileGeneralError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordErrors, setPasswordErrors] = useState<PasswordFieldErrors>({});
  const [passwordGeneralError, setPasswordGeneralError] = useState('');

  const profileMutation = useMutation({
    mutationFn: async (payload: { name: string; email: string }) => {
      const { data } = await api.put<ApiResponse<{ user: User }>>('/profile', payload);
      return data.data!.user;
    },
    onSuccess: (updatedUser) => {
      setUser(updatedUser);
      setProfileErrors({});
      setProfileGeneralError('');
      toast.success('Profile updated successfully');
    },
    onError: (err) => {
      const fieldErrors = extractFieldErrors<ProfileFieldErrors>(err);
      if (fieldErrors) {
        setProfileErrors(fieldErrors);
        setProfileGeneralError('');
      } else {
        setProfileErrors({});
        setProfileGeneralError(extractMessage(err, 'Failed to update profile'));
      }
    },
  });

  const passwordMutation = useMutation({
    mutationFn: async (payload: {
      currentPassword: string;
      newPassword: string;
      confirmPassword: string;
    }) => {
      await api.put('/profile/password', payload);
    },
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordErrors({});
      setPasswordGeneralError('');
      toast.success('Password updated successfully');
    },
    onError: (err) => {
      const fieldErrors = extractFieldErrors<PasswordFieldErrors>(err);
      if (fieldErrors) {
        setPasswordErrors(fieldErrors);
        setPasswordGeneralError('');
      } else {
        setPasswordErrors({});
        setPasswordGeneralError(extractMessage(err, 'Failed to update password'));
      }
    },
  });

  function handleProfileSubmit(e: FormEvent) {
    e.preventDefault();
    setProfileErrors({});
    setProfileGeneralError('');
    profileMutation.mutate({ name: name.trim(), email: email.trim() });
  }

  function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordErrors({});
    setPasswordGeneralError('');
    passwordMutation.mutate({ currentPassword, newPassword, confirmPassword });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your personal account information.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Personal Info */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <UserCircle className="size-5 text-muted-foreground" />
              <CardTitle>Personal Information</CardTitle>
            </div>
            <CardDescription>Update your name and email address.</CardDescription>
          </CardHeader>
          <CardContent>
            {profileGeneralError && (
              <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {profileGeneralError}
              </div>
            )}

            <form onSubmit={handleProfileSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your full name"
                  aria-invalid={!!profileErrors.name}
                  className="h-10"
                  required
                />
                {profileErrors.name?.map((msg) => (
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
                  aria-invalid={!!profileErrors.email}
                  className="h-10"
                  required
                />
                {profileErrors.email?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </div>

              <Button type="submit" disabled={profileMutation.isPending}>
                {profileMutation.isPending && <Loader2 className="animate-spin" />}
                {profileMutation.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Change Password */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Lock className="size-5 text-muted-foreground" />
              <CardTitle>Change Password</CardTitle>
            </div>
            <CardDescription>Update your password to keep your account secure.</CardDescription>
          </CardHeader>
          <CardContent>
            {passwordGeneralError && (
              <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {passwordGeneralError}
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current Password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  aria-invalid={!!passwordErrors.currentPassword}
                  className="h-10"
                  required
                />
                {passwordErrors.currentPassword?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </div>

              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  aria-invalid={!!passwordErrors.newPassword}
                  className="h-10"
                  required
                />
                {passwordErrors.newPassword?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  aria-invalid={!!passwordErrors.confirmPassword}
                  className="h-10"
                  required
                />
                {passwordErrors.confirmPassword?.map((msg) => (
                  <p key={msg} className="text-xs text-destructive">{msg}</p>
                ))}
              </div>

              <Button type="submit" disabled={passwordMutation.isPending}>
                {passwordMutation.isPending && <Loader2 className="animate-spin" />}
                {passwordMutation.isPending ? 'Updating…' : 'Update Password'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
