import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export default function LegalFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        'mt-8 border-t border-border pt-4 text-center text-xs text-muted-foreground',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <Link to="/privacy-policy" className="hover:text-foreground hover:underline">
          Politika e privatësisë
        </Link>
        <Link to="/terms-of-service" className="hover:text-foreground hover:underline">
          Kushtet e shërbimit
        </Link>
        <Link to="/data-deletion" className="hover:text-foreground hover:underline">
          Fshirja e të dhënave
        </Link>
      </div>
    </footer>
  );
}
