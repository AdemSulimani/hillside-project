import { Spinner } from '@/components/ui/spinner';

/** Shown while a lazy route chunk loads (full viewport — e.g. home, auth, onboarding). */
export function FullPageRouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Spinner className="size-8 text-muted-foreground" />
    </div>
  );
}

/** Shown inside CRM layout while a lazy child route loads (sidebar + header stay visible). */
export function CRMRouteFallback() {
  return (
    <div className="flex min-h-[40vh] flex-1 items-center justify-center">
      <Spinner className="size-8 text-muted-foreground" />
    </div>
  );
}
