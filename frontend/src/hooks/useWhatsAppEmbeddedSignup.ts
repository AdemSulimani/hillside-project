import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { toast } from 'sonner';
import { connectWhatsAppEmbeddedSignup, getWhatsAppSignupState } from '@/api/channelsApi';

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError) {
    const data = err.response?.data as { message?: unknown; error?: unknown } | undefined;
    if (data?.message != null) return String(data.message);
    if (data?.error != null && typeof data.error === 'string') return data.error;
    if (data?.error != null && typeof data.error === 'object' && data.error !== null) {
      try {
        return JSON.stringify(data.error);
      } catch {
        /* ignore */
      }
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function waitForFacebookSdk(timeoutMs = 15_000): Promise<FacebookStatic> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const fb = window.FB;
      if (fb) {
        resolve(fb);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Facebook SDK did not load in time. Check your network or ad blockers.'));
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

function requestAuthorizationCode(): Promise<string> {
  const configId = import.meta.env.VITE_WHATSAPP_CONFIGURATION_ID as string | undefined;
  if (!configId?.trim()) {
    return Promise.reject(
      new Error('Missing VITE_WHATSAPP_CONFIGURATION_ID. Add it to your frontend environment.'),
    );
  }

  return new Promise((resolve, reject) => {
    window.FB!.login(
      (response) => {
        const code = response.authResponse?.code;
        if (code) {
          resolve(code);
          return;
        }
        if (response.status === 'not_authorized' || response.status === 'unknown') {
          reject(new Error('WhatsApp sign-in was cancelled or did not complete.'));
          return;
        }
        reject(
          new Error(
            response.errorMessage?.trim() ||
              'No authorization code was returned from Meta. Try again or check your app configuration.',
          ),
        );
      },
      {
        config_id: configId.trim(),
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3',
        },
      },
    );
  });
}

export function useWhatsAppEmbeddedSignup(): {
  startSignup: () => Promise<boolean>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);

  const startSignup = useCallback(async (): Promise<boolean> => {
    setIsPending(true);
    try {
      const appId = import.meta.env.VITE_META_APP_ID as string | undefined;
      if (!appId?.trim()) {
        throw new Error('Missing VITE_META_APP_ID. Add it to your frontend environment.');
      }

      const { state } = await getWhatsAppSignupState();
      await waitForFacebookSdk();
      const code = await requestAuthorizationCode();
      await connectWhatsAppEmbeddedSignup({ code, state });
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      return true;
    } catch (err) {
      toast.error(
        extractMessage(err, 'WhatsApp connection failed — please try again'),
      );
      return false;
    } finally {
      setIsPending(false);
    }
  }, [queryClient]);

  return { startSignup, isPending };
}
