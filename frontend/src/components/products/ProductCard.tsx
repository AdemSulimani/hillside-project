import { Pencil, Trash2, Package } from 'lucide-react';
import { formatCurrency } from '@/lib/formatCurrency';
import { assetUrl, cn } from '@/lib/utils';
import type { Product } from '@/types/product';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';

interface ProductCardProps {
  product: Product;
  onEdit: (product: Product) => void;
  onDelete: (product: Product) => void;
  className?: string;
}

export function ProductCard({ product, onEdit, onDelete, className }: ProductCardProps) {
  const cover = product.image_urls[0];
  const coverSrc = assetUrl(cover);

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden transition-shadow hover:shadow-md',
        !product.is_active && 'opacity-70',
        className,
      )}
    >
      <div className="relative aspect-[4/3] bg-muted">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt=""
            className="size-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Package className="size-12 opacity-40" />
          </div>
        )}
        {!product.is_active && (
          <Badge variant="secondary" className="absolute right-2 top-2 text-xs">
            Joaktiv
          </Badge>
        )}
      </div>
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="space-y-1">
          <h3 className="line-clamp-2 font-heading text-sm font-medium leading-snug">
            {product.name}
          </h3>
          {product.brand?.trim() && (
            <p className="text-xs text-muted-foreground">{product.brand}</p>
          )}
          {product.discounted_price != null ? (
            <div className="flex items-baseline gap-2">
              <p className="text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                {formatCurrency(product.discounted_price)}
              </p>
              <p className="text-sm text-muted-foreground line-through tabular-nums">
                {formatCurrency(product.price)}
              </p>
            </div>
          ) : (
            <p className="text-lg font-semibold tabular-nums">
              {formatCurrency(product.price)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {product.brand?.trim() && (
            <Badge variant="outline" className="text-xs font-normal">
              Marka: {product.brand}
            </Badge>
          )}
          {product.sku && (
            <Badge variant="outline" className="text-xs font-normal">
              SKU: {product.sku}
            </Badge>
          )}
          {product.category && (
            <Badge variant="outline" className="text-xs font-normal">
              {product.category}
            </Badge>
          )}
        </div>
        {product.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {product.tags.slice(0, 4).map((t) => (
              <Badge key={t} variant="secondary" className="text-xs font-normal">
                {t}
              </Badge>
            ))}
            {product.tags.length > 4 && (
              <span className="text-xs text-muted-foreground">+{product.tags.length - 4}</span>
            )}
          </div>
        )}
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {product.description || 'Pa përshkrim'}
        </p>
        <p className="text-xs text-muted-foreground">
          {product.in_stock !== false ? 'Në stok' : 'Jashtë stokut'}
        </p>
        <div>
          {product.usage_description?.trim() ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300">
              Përdorimi ✓
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-muted-foreground">
              Pa info përdorimi
            </Badge>
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-auto flex gap-2 border-t bg-muted/30 p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => onEdit(product)}
        >
          <Pencil className="size-3.5" />
          Ndrysho
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="flex-1"
          onClick={() => onDelete(product)}
        >
          <Trash2 className="size-3.5" />
          Fshi
        </Button>
      </CardFooter>
    </Card>
  );
}
