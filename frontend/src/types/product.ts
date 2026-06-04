export type ProductSourceType = 'manual' | 'pdf' | 'spreadsheet' | 'image';

export interface Product {
  id: string;
  tenant_id: string;
  name: string;
  brand: string | null;
  price: number;
  discounted_price: number | null;
  description: string | null;
  usage_description: string | null;
  sku: string | null;
  category: string | null;
  tags: string[];
  flavor: string | null;
  size: string | null;
  color: string | null;
  variant: string | null;
  weight: string | null;
  image_urls: string[];
  is_active: boolean;
  in_stock: boolean;
  source_type: ProductSourceType;
  extracted_text: string | null;
  metadata: Record<string, unknown> | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductListParams {
  search?: string;
  tags?: string;
  is_active?: boolean;
  page?: number;
  limit?: number;
}

export interface CreateProductBody {
  name: string;
  brand?: string | null;
  price: number;
  discounted_price?: number | null;
  description?: string | null;
  usage_description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  flavor?: string | null;
  size?: string | null;
  color?: string | null;
  variant?: string | null;
  weight?: string | null;
  is_active?: boolean;
  in_stock?: boolean;
}

export type UpdateProductBody = Partial<CreateProductBody> & {
  image_urls?: string[];
};
