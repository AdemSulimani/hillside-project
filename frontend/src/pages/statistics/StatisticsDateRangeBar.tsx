import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { parseYmdLocalEnd, parseYmdLocalStart, type StatisticsPresetId } from './dateRangePresets';

const PRESETS: { id: Exclude<StatisticsPresetId, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
];

const customRangeSchema = z
  .object({
    startYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid start date'),
    endYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid end date'),
  })
  .superRefine((v, ctx) => {
    try {
      const s = parseYmdLocalStart(v.startYmd);
      const e = parseYmdLocalEnd(v.endYmd);
      if (s.getTime() > e.getTime()) {
        ctx.addIssue({
          code: 'custom',
          message: 'Start date must be on or before end date',
          path: ['endYmd'],
        });
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid date',
        path: ['startYmd'],
      });
    }
  });

export interface StatisticsDateRangeBarProps {
  preset: StatisticsPresetId;
  onPresetChange: (preset: StatisticsPresetId) => void;
  rangeStart: Date;
  rangeEnd: Date;
  onApplyCustom: (start: Date, end: Date) => void;
  customStartYmd: string;
  customEndYmd: string;
  onCustomDraftChange: (patch: { start?: string; end?: string }) => void;
  disabled?: boolean;
}

export function StatisticsDateRangeBar({
  preset,
  onPresetChange,
  rangeStart,
  rangeEnd,
  onApplyCustom,
  customStartYmd,
  customEndYmd,
  onCustomDraftChange,
  disabled,
}: StatisticsDateRangeBarProps) {
  function handleApplyCustom() {
    const parsed = customRangeSchema.safeParse({
      startYmd: customStartYmd,
      endYmd: customEndYmd,
    });
    if (!parsed.success) {
      const first = parsed.error.issues[0]?.message ?? 'Invalid range';
      toast.error(first);
      return;
    }
    const start = parseYmdLocalStart(parsed.data.startYmd);
    const end = parseYmdLocalEnd(parsed.data.endYmd);
    onApplyCustom(start, end);
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map(({ id, label }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={preset === id ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => onPresetChange(id)}
          >
            {label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={preset === 'custom' ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onPresetChange('custom')}
        >
          Custom
        </Button>
      </div>

      {preset === 'custom' ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="stats-range-start">Start</Label>
            <input
              id="stats-range-start"
              type="date"
              value={customStartYmd}
              disabled={disabled}
              onChange={(e) => onCustomDraftChange({ start: e.target.value })}
              className="h-10 w-full min-w-[10rem] rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 sm:w-auto"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stats-range-end">End</Label>
            <input
              id="stats-range-end"
              type="date"
              value={customEndYmd}
              disabled={disabled}
              onChange={(e) => onCustomDraftChange({ end: e.target.value })}
              className="h-10 w-full min-w-[10rem] rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 sm:w-auto"
            />
          </div>
          <Button type="button" size="sm" disabled={disabled} onClick={handleApplyCustom}>
            Apply range
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Period:{' '}
        <span className="font-medium text-foreground">
          {rangeStart.toLocaleDateString(undefined, { dateStyle: 'medium' })}
        </span>{' '}
        —{' '}
        <span className="font-medium text-foreground">
          {rangeEnd.toLocaleDateString(undefined, { dateStyle: 'medium' })}
        </span>
      </p>
    </div>
  );
}
