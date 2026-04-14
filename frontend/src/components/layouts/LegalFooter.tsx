import { Link } from 'react-router-dom';

export default function LegalFooter() {
  return (
    <footer className="mt-8 border-t border-border pt-4 text-center text-xs text-muted-foreground">
      <div className="flex items-center justify-center gap-4">
        <Link to="/privacy-policy" className="hover:text-foreground hover:underline">
          Privacy Policy
        </Link>
        <Link to="/terms-of-service" className="hover:text-foreground hover:underline">
          Terms of Service
        </Link>
      </div>
    </footer>
  );
}
