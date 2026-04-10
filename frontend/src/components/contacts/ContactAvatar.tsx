import { cn } from '@/lib/utils';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

export function ContactAvatar({
  name,
  avatarUrl,
  size = 'md',
  className,
}: {
  name: string;
  avatarUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dim = size === 'lg' ? 'size-14 text-lg' : size === 'sm' ? 'size-8 text-xs' : 'size-10 text-sm';

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={cn('rounded-full object-cover', dim, className)}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground',
        dim,
        className,
      )}
      aria-hidden
    >
      {initials(name)}
    </div>
  );
}
