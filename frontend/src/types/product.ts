export type ProductSourceType = 'manual' | 'pdf' | 'spreadsheet' | 'image';

export interface Product {
  id: string;
  tenant_id: string;
  name: string;
  brand: string | null;
  price: number;
  description: string | null;
  usage_description: string | null;
  sku: string | null;
  category: string | null;
  tags: string[];
  image_urls: string[];
  is_active: boolean;
  stock_quantity: number | null;
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
  description?: string | null;
  usage_description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  is_active?: boolean;
  stock_quantity?: number | null;
}

export type UpdateProductBody = Partial<CreateProductBody> & {
  image_urls?: string[];
};
