export {};

/** Minimal typings for the Meta Facebook JS SDK used by WhatsApp Embedded Signup. */
declare global {
  interface FacebookAuthResponse {
    accessToken?: string;
    code?: string;
    expiresIn?: number;
    signedRequest?: string;
    userID?: string;
  }

  interface FacebookLoginResponse {
    status: 'connected' | 'not_authorized' | 'unknown';
    authResponse?: FacebookAuthResponse;
    errorMessage?: string;
  }

  interface FacebookStatic {
    init(config: {
      appId: string;
      autoLogAppEvents?: boolean;
      xfbml?: boolean;
      version: string;
    }): void;
    login(callback: (response: FacebookLoginResponse) => void, opts?: Record<string, unknown>): void;
  }

  interface Window {
    FB?: FacebookStatic;
    fbAsyncInit?: () => void;
  }
}
