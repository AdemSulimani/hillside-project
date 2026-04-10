export interface QAPair {
  question: string;
  answer: string;
}

export interface AIConfig {
  id: string;
  tenant_id: string;
  tone: string;
  personality_description: string | null;
  restrictions: string[];
  sales_strategy: string | null;
  objection_handling: string | null;
  qa_pairs: QAPair[];
  is_active: boolean;
  custom_model_id: string | null;
  feedback_count: number;
  created_at: string;
  updated_at: string;
}

export interface AIConfigUpdatePayload {
  tone: string;
  personality_description: string | null;
  restrictions: string[];
  sales_strategy: string | null;
  objection_handling: string | null;
  qa_pairs: QAPair[];
  is_active: boolean;
  custom_model_id: string | null;
}

export interface AIConfigTestPayload extends AIConfigUpdatePayload {
  testMessage: string;
}
