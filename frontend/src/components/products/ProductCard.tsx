import { Pencil, Trash2, Package } from 'lucide-react';
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
          <img src={coverSrc} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Package className="size-12 opacity-40" />
          </div>
        )}
        {!product.is_active && (
          <Badge variant="secondary" className="absolute right-2 top-2 text-xs">
            Inactive
          </Badge>
        )}
      </div>
      <CardContent className="flex flex-1 flex-col gap-2 p-4">
        <div className="space-y-1">
          <h3 className="line-clamp-2 font-heading text-sm font-medium leading-snug">
            {product.name}
          </h3>
          <p className="text-lg font-semibold tabular-nums">
            ${product.price.toFixed(2)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
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
          {product.description || 'No description'}
        </p>
        {product.stock_quantity != null && (
          <p className="text-xs text-muted-foreground">Stock: {product.stock_quantity}</p>
        )}
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
          Edit
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="flex-1"
          onClick={() => onDelete(product)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </CardFooter>
    </Card>
  );
}
