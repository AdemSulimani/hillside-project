import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const CHUNK_RELOAD_FLAG = 'lazy-retry:__error_boundary__';

function isChunkLoadError(error: Error): boolean {
  const message = error.message || '';
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /ChunkLoadError/i.test(error.name)
  );
}

/**
 * Catches render errors in the subtree and shows a friendly fallback instead of a blank screen.
 *
 * If the error looks like a stale-deploy chunk load failure (browser had an old tab open
 * while we shipped a new build), perform a one-shot full reload to fetch the new index.html
 * and the matching new bundle hashes. The session-storage flag prevents a reload loop on
 * genuine network failures.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    if (isChunkLoadError(error) && sessionStorage.getItem(CHUNK_RELOAD_FLAG) !== '1') {
      sessionStorage.setItem(CHUNK_RELOAD_FLAG, '1');
      window.location.reload();
      return { hasError: false, error: null };
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-16 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-8" aria-hidden />
          </div>
          <div className="max-w-md space-y-2">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Diçka shkoi keq
            </h1>
            <p className="text-sm text-muted-foreground">
              Aplikacioni hasi një gabim të papritur. Mund të provoni përsëri ose të rifreskoni faqen. Nëse problemi
              vazhdon, kontaktoni mbështetjen.
            </p>
            {import.meta.env.DEV ? (
              <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-border bg-muted p-3 text-left text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button type="button" onClick={this.handleRetry}>
              Provo përsëri
            </Button>
            <Button type="button" variant="outline" onClick={this.handleReload}>
              Rifresko faqen
            </Button>
          </div>
        </div>
      );
    }

    if (sessionStorage.getItem(CHUNK_RELOAD_FLAG) === '1') {
      sessionStorage.removeItem(CHUNK_RELOAD_FLAG);
    }
    return this.props.children;
  }
}
