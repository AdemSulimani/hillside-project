/**
 * Narrow AI fields returned to onboarded CRM users.
 * Full prompt text and mutable settings are edited from the admin dashboard only.
 */
export interface TenantAIConfigPublic {
  is_active: boolean;
  custom_model_id: string | null;
  feedback_count: number;
}
