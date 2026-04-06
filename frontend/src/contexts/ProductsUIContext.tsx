import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Product } from '@/types/product';

type UploadKind = 'document' | 'image';

interface ProductsUIContextValue {
  openManualCreate: () => void;
  openEdit: (product: Product) => void;
  closeForm: () => void;
  formOpen: boolean;
  formMode: 'create' | 'edit';
  formProduct: Product | null;
  openUpload: (kind: UploadKind) => void;
  closeUpload: () => void;
  uploadOpen: boolean;
  uploadKind: UploadKind | null;
}

const ProductsUIContext = createContext<ProductsUIContextValue | null>(null);

export function ProductsUIProvider({ children }: { children: ReactNode }) {
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [formProduct, setFormProduct] = useState<Product | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState<UploadKind | null>(null);

  const openManualCreate = useCallback(() => {
    setFormMode('create');
    setFormProduct(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((product: Product) => {
    setFormMode('edit');
    setFormProduct(product);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setFormProduct(null);
  }, []);

  const openUpload = useCallback((kind: UploadKind) => {
    setUploadKind(kind);
    setUploadOpen(true);
  }, []);

  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    setUploadKind(null);
  }, []);

  const value = useMemo(
    () => ({
      openManualCreate,
      openEdit,
      closeForm,
      formOpen,
      formMode,
      formProduct,
      openUpload,
      closeUpload,
      uploadOpen,
      uploadKind,
    }),
    [
      openManualCreate,
      openEdit,
      closeForm,
      formOpen,
      formMode,
      formProduct,
      openUpload,
      closeUpload,
      uploadOpen,
      uploadKind,
    ],
  );

  return (
    <ProductsUIContext.Provider value={value}>{children}</ProductsUIContext.Provider>
  );
}

export function useProductsUI(): ProductsUIContextValue {
  const ctx = useContext(ProductsUIContext);
  if (!ctx) {
    throw new Error('useProductsUI must be used within ProductsUIProvider');
  }
  return ctx;
}
