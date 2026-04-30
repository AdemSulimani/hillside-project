export interface User {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'manager' | 'member';
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
}

export type DeliveryTime = '24h' | '48h' | '72h';

export interface Tenant {
  id: string;
  name: string;
  niche: string;
  description: string | null;
  delivery_methods: string[];
  delivery_time: DeliveryTime | null;
  logo_url: string | null;
  plan: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  channelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  tenantId: string;
  userId: string;
  status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginatedResponse<T = unknown> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
