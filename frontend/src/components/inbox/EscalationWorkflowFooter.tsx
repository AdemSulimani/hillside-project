import { Link } from 'react-router-dom';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Shared actions after staff handles an escalation: optional link to the full alerts page,
 * close alert while keeping AI paused, or close and resume automation.
 */
export function EscalationWorkflowFooter({
  resolvePending,
  onResolveKeepPaused,
  onResolveResume,
  className,
}: {
  resolvePending: boolean;
  onResolveKeepPaused: () => void;
  onResolveResume: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Link to="/ai-alerts" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'inline-flex')}>
        Hap Alarmet IA
      </Link>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={resolvePending}
        onClick={onResolveKeepPaused}
      >
        Mbyll alarmin (IA e ndalur)
      </Button>
      <Button type="button" size="sm" disabled={resolvePending} onClick={onResolveResume}>
        Mbyll alarmin dhe rifillo IA-në
      </Button>
    </div>
  );
}
