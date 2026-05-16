import axios from 'axios';
import crypto from 'crypto';
import { cryptoService } from './cryptoService';

const GRAPH_VERSION = 'v25.0';

type MetaErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number };
};

export interface CloudApiRegistrationResult {
  registered: boolean;
  skipped?: boolean;
  pinEncrypted?: string;
  error?: string;
}

function graphBase(): string {
  const fromEnv = process.env.WHATSAPP_BUSINESS_MANAGEMENT_API?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }
  return `https://graph.facebook.com/${GRAPH_VERSION}`;
}

function generateRegistrationPin(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

function metaErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as MetaErrorBody | undefined;
    return body?.error?.message?.trim() || err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'Cloud API registration failed';
}

/** Number already on Cloud API or PIN mismatch (registered with another PIN). */
function isBenignRegistrationError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    return false;
  }
  const body = err.response?.data as MetaErrorBody | undefined;
  const msg = body?.error?.message?.toLowerCase() ?? '';
  if (msg.includes('already registered')) {
    return true;
  }
  // Registered previously; platform does not have the original PIN.
  if (body?.error?.code === 133005) {
    return true;
  }
  return false;
}

function readExistingPinEncrypted(metadata: Record<string, unknown> | null | undefined): string | undefined {
  const raw = metadata?.registration_pin_encrypted;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Activates a business phone number on WhatsApp Cloud API (POST /{phone_number_id}/register).
 * Skips when Meta already reports CONNECTED or the number is already registered.
 */
export async function ensureCloudApiRegistration(
  phoneNumberId: string,
  accessToken: string,
  existingMetadata?: Record<string, unknown> | null,
): Promise<CloudApiRegistrationResult> {
  const base = graphBase();
  const headers = { Authorization: `Bearer ${accessToken}` };

  try {
    const { data } = await axios.get<{ status?: string }>(`${base}/${phoneNumberId}`, {
      params: { fields: 'status' },
      headers,
    });
    if (data.status?.toUpperCase() === 'CONNECTED') {
      return { registered: true, skipped: true };
    }
  } catch {
    // Continue to /register — token may still allow registration.
  }

  let pin = generateRegistrationPin();
  const existingPinEncrypted = readExistingPinEncrypted(existingMetadata ?? undefined);
  if (existingPinEncrypted) {
    try {
      pin = cryptoService.decrypt(existingPinEncrypted);
    } catch {
      // Use newly generated pin if stored value cannot be decrypted.
    }
  }

  try {
    await axios.post(
      `${base}/${phoneNumberId}/register`,
      { messaging_product: 'whatsapp', pin },
      { headers: { ...headers, 'Content-Type': 'application/json' } },
    );
    return {
      registered: true,
      pinEncrypted: cryptoService.encrypt(pin),
    };
  } catch (err) {
    if (isBenignRegistrationError(err)) {
      return { registered: true, skipped: true };
    }
    const message = metaErrorMessage(err);
    console.warn('[whatsapp.register] Cloud API registration failed', {
      phoneNumberId,
      message,
    });
    return { registered: false, error: message };
  }
}

export function buildWhatsAppChannelMetadata(
  base: Record<string, unknown>,
  registration: CloudApiRegistrationResult,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...base,
    cloud_api_registered: registration.registered,
  };
  if (registration.skipped) {
    metadata.cloud_api_registration_skipped = true;
  }
  if (registration.pinEncrypted) {
    metadata.registration_pin_encrypted = registration.pinEncrypted;
  }
  if (registration.error) {
    metadata.cloud_api_registration_error = registration.error;
  }
  return metadata;
}
