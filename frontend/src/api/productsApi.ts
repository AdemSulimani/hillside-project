import api from '@/lib/api';
import type { ApiResponse, PaginatedResponse } from '@/types';
import type { CreateProductBody, Product, ProductListParams, UpdateProductBody } from '@/types/product';

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function normalizeProduct(raw: Record<string, unknown>): Product {
  const tags = raw.tags;
  const imageUrls = raw.image_urls;
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    name: String(raw.name ?? ''),
    price: toNum(raw.price),
    description: raw.description != null ? String(raw.description) : null,
    usage_description: raw.usage_description != null ? String(raw.usage_description) : null,
    sku: raw.sku != null ? String(raw.sku) : null,
    category: raw.category != null ? String(raw.category) : null,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    image_urls: Array.isArray(imageUrls) ? imageUrls.map(String) : [],
    is_active: Boolean(raw.is_active),
    stock_quantity:
      raw.stock_quantity === null || raw.stock_quantity === undefined
        ? null
        : Number(raw.stock_quantity),
    source_type: (raw.source_type as Product['source_type']) ?? 'manual',
    extracted_text: raw.extracted_text != null ? String(raw.extracted_text) : null,
    metadata:
      raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : null,
    deleted_at: raw.deleted_at != null ? String(raw.deleted_at) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

type ProductsListJson = {
  success: boolean;
  data: Record<string, unknown>[];
  pagination: PaginatedResponse<unknown>['pagination'];
  message?: string;
};

type ProductTagsJson = {
  success: boolean;
  data?: { tags?: unknown[] };
  message?: string;
};

export async function fetchProducts(
  params: ProductListParams,
): Promise<{ products: Product[]; pagination: PaginatedResponse<Product>['pagination'] }> {
  const { data } = await api.get<ProductsListJson>('/products', {
    params: {
      search: params.search || undefined,
      tags: params.tags || undefined,
      is_active:
        params.is_active === undefined ? undefined : params.is_active ? 'true' : 'false',
      page: params.page ?? 1,
      limit: params.limit ?? 20,
    },
  });

  const rows = data.data ?? [];
  const products = rows.map(normalizeProduct);
  const pagination = data.pagination ?? {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  };
  return { products, pagination };
}

export async function fetchProductTags(): Promise<string[]> {
  const { data } = await api.get<ProductTagsJson>('/products/tags');
  const tags = data.data?.tags ?? [];
  return tags.map(String).sort((a, b) => a.localeCompare(b));
}

export async function fetchProduct(id: string): Promise<Product> {
  const { data } = await api.get<ApiResponse<{ product: Record<string, unknown> }>>(
    `/products/${id}`,
  );
  return normalizeProduct(data.data!.product);
}

export async function createProduct(body: CreateProductBody): Promise<Product> {
  const { data } = await api.post<ApiResponse<{ product: Record<string, unknown> }>>(
    '/products',
    body,
  );
  return normalizeProduct(data.data!.product);
}

export async function updateProduct(id: string, body: UpdateProductBody): Promise<Product> {
  const { data } = await api.put<ApiResponse<{ product: Record<string, unknown> }>>(
    `/products/${id}`,
    body,
  );
  return normalizeProduct(data.data!.product);
}

export async function deleteProduct(id: string): Promise<void> {
  await api.delete(`/products/${id}`);
}

export async function uploadProductImages(id: string, files: File[]): Promise<Product> {
  const formData = new FormData();
  files.forEach((f) => formData.append('images', f));
  const { data } = await api.post<ApiResponse<{ product: Record<string, unknown> }>>(
    `/products/${id}/images`,
    formData,
  );
  return normalizeProduct(data.data!.product);
}

export async function uploadProductDocument(
  file: File,
  useAi: boolean,
): Promise<{ products: Product[]; count: number }> {
  const formData = new FormData();
  formData.append('document', file);
  if (useAi) formData.append('use_ai', 'true');
  const { data } = await api.post<
    ApiResponse<{ products: Record<string, unknown>[]; count: number }>
  >('/products/upload/document', formData);
  const list = data.data?.products ?? [];
  return {
    products: list.map((p) => normalizeProduct(p as Record<string, unknown>)),
    count: data.data?.count ?? list.length,
  };
}

export async function uploadProductOcrImage(file: File, useAi: boolean): Promise<Product> {
  const formData = new FormData();
  formData.append('image', file);
  if (useAi) formData.append('use_ai', 'true');
  const { data } = await api.post<ApiResponse<{ product: Record<string, unknown> }>>(
    '/products/upload/image',
    formData,
  );
  return normalizeProduct(data.data!.product);
}
