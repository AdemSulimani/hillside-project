import { AlertTriangle } from 'lucide-react';
import { AI_ALERT_RESOLUTION_HINT, formatFlagReason } from '@/lib/aiAlertLabels';
import { Button } from '@/components/ui/button';
import type { OpenAIAlertSummary } from '@/types/conversation';

interface AiQualityConversationBannerProps {
  openAlert: OpenAIAlertSummary;
  resolvePending: boolean;
  onResumeAi: () => void;
  onKeepManual: () => void;
}

export function AiQualityConversationBanner({
  openAlert,
  resolvePending,
  onResumeAi,
  onKeepManual,
}: AiQualityConversationBannerProps) {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 dark:bg-amber-950/30">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex gap-3 min-w-0">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/25 text-amber-800 dark:text-amber-200">
            <AlertTriangle className="size-5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="font-semibold text-foreground">IA-ja u shënua në këtë bisedë</p>
            <p className="text-sm text-muted-foreground">
              Arsyeja: <span className="font-medium text-foreground">{formatFlagReason(openAlert.reason)}</span>.
              IA-ja është ndalur. Tani keni kontrollin ju.
            </p>
            <p className="text-sm text-muted-foreground">{AI_ALERT_RESOLUTION_HINT}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={resolvePending}
            onClick={onKeepManual}
          >
            Mbaj manualisht
          </Button>
          <Button type="button" size="sm" disabled={resolvePending} onClick={onResumeAi}>
            Rifillo IA-në
          </Button>
        </div>
      </div>
    </div>
  );
}
