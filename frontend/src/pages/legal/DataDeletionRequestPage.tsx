import { Link } from 'react-router-dom';

export default function DataDeletionRequestPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Data deletion requests</h1>
      <p className="mt-4 text-sm leading-6 text-muted-foreground">
        This page explains how to request deletion of personal data associated with your use of our platform.
      </p>

      <div className="mt-8 space-y-6 text-sm leading-6 text-foreground">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Business accounts (tenants)</h2>
          <p>
            To request deletion of your organization&apos;s account and related data, email{' '}
            <a href="mailto:[privacy@yourdomain.com]" className="font-medium text-primary underline">
              [privacy@yourdomain.com]
            </a>{' '}
            from the address registered on your account. Include your business name and the email used to sign in so we
            can verify your request.
          </p>
          <p>
            We will confirm receipt and process verified deletion requests in line with our{' '}
            <Link to="/privacy-policy" className="font-medium text-primary underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">End customers (people who messaged a business)</h2>
          <p>
            If you messaged a business that uses our software, contact that business first. You may also email us at the
            address above and we will help route or fulfill the request where we are responsible for the data.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Meta / Facebook / Instagram / WhatsApp Business</h2>
          <p>
            For requests related to data received through Meta products, use the subject line{' '}
            <strong>Meta Data Deletion Request</strong> and include details needed to locate your records (for example
            your Page name, approximate dates, and your registered account email).
          </p>
        </section>

        <p className="text-xs text-muted-foreground">
          For general privacy questions, see the{' '}
          <Link to="/privacy-policy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
