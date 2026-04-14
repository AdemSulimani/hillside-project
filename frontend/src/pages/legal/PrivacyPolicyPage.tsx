const EFFECTIVE_DATE = 'April 14, 2026';
const LAST_UPDATED = 'April 14, 2026';

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective Date: {EFFECTIVE_DATE}</p>
      <p className="text-sm text-muted-foreground">Last Updated: {LAST_UPDATED}</p>

      <div className="mt-8 space-y-8 text-sm leading-6 text-foreground">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">1. Who We Are</h2>
          <p>
            [Your Company Legal Name] (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates [Platform Name], an AI-powered
            social messaging and sales automation platform for businesses.
          </p>
          <p>
            Contact us:
            <br />
            Email: [support@yourdomain.com]
            <br />
            Address: [Full legal address]
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">2. What Data We Collect</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Account and business data:</strong> name, email, business profile details, and onboarding
              settings.
            </li>
            <li>
              <strong>Connected channel data:</strong> Page IDs, Instagram account IDs, WhatsApp phone number IDs,
              and encrypted access credentials.
            </li>
            <li>
              <strong>Message and conversation data:</strong> inbound/outbound content, attachments, sender platform
              identifiers, timestamps, and conversation history.
            </li>
            <li>
              <strong>Order and contact data:</strong> customer details provided during conversations and related order
              records.
            </li>
            <li>
              <strong>Product catalog and AI settings:</strong> products, pricing, AI tone, restrictions, and related
              configuration.
            </li>
            <li>
              <strong>Usage and security logs:</strong> technical and operational logs (which may include IP address,
              browser/device information, and access/session events) where available through our platform
              infrastructure and security tooling.
            </li>
            <li>
              <strong>AI feedback data:</strong> feedback and corrections submitted on AI responses.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">3. Where Data Comes From</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Directly from you (account setup, onboarding, product setup, support requests).</li>
            <li>
              From Meta platforms through APIs and webhooks when your connected channels receive customer messages.
            </li>
            <li>From your use of our dashboard and platform features.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">4. Why We Process Data</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>Provide channel connection, inbox, and reply functionality.</li>
            <li>Generate AI replies and assist sales conversations.</li>
            <li>Detect purchase intent and support order workflows.</li>
            <li>Provide analytics, quality monitoring, and service improvements.</li>
            <li>Maintain account security, fraud prevention, and customer support.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">5. Legal Basis (EU/UK)</h2>
          <p>Where required by law, we rely on one or more of the following legal bases:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Performance of a contract.</li>
            <li>Legitimate interests (for example, security and product operations).</li>
            <li>Consent (where legally required, such as optional marketing communications).</li>
            <li>Compliance with legal obligations.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">6. Meta Platform Data and AI Processing</h2>
          <p>
            We process Meta Platform Data solely to provide messaging, inbox, and automation features requested by our
            users. We do not sell Meta Platform Data and do not use it for unrelated advertising, profiling, or data
            brokerage purposes.
          </p>
          <p>
            Message content and attachments may be processed by AI and infrastructure providers acting on our behalf to
            power replies, quality checks, and product functionality.
          </p>
          <p>
            We use service providers under contractual terms requiring appropriate data protection and restricted use.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">7. How We Share Data</h2>
          <p>We do not sell personal data.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>With service providers that operate our platform on our behalf.</li>
            <li>With Meta APIs when sending replies through connected channels.</li>
            <li>When required by law or valid legal process.</li>
            <li>In a merger, acquisition, or asset sale with appropriate safeguards.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">8. Data Retention</h2>
          <p>
            We retain data only as long as needed for legitimate business purposes, legal obligations, dispute
            resolution, security, and enforcement of agreements. You can request deletion as described below.
          </p>
          <p>
            If you publish specific retention periods elsewhere (for example in contracts or admin docs), those
            published periods govern unless legal obligations require longer retention.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">9. Your Rights</h2>
          <p>
            Depending on your location, you may have rights to access, correct, delete, restrict, or object to certain
            processing, and to request portability where applicable.
          </p>
          <p>
            To exercise these rights, contact: [privacy@yourdomain.com]. We will respond within the timeframe required
            by applicable law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">10. Data Deletion Requests</h2>
          <p>You can request deletion by contacting [privacy@yourdomain.com].</p>
          <p>We may also provide in-app deletion tools where available.</p>
          <p>
            If you are an end customer messaging a business that uses our platform, you may contact that business
            directly, or contact us and we will assist where applicable.
          </p>
          <p>
            For Meta platform-related deletion instructions, contact [privacy@yourdomain.com] with subject line
            &quot;Meta Data Deletion Request&quot; and include identifying details needed to locate your records.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">11. Security</h2>
          <p>
            We use technical and organizational safeguards designed to protect personal data, including encrypted
            transport, access controls, and operational security monitoring.
          </p>
          <p>
            No method of transmission or storage is perfectly secure. If you believe you found a security issue, please
            contact [security@yourdomain.com].
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">12. International Transfers</h2>
          <p>
            We may process data in countries outside your own. Where required, we use appropriate safeguards for
            international transfers, such as contractual protections and legal transfer mechanisms.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">13. Children</h2>
          <p>
            Our service is intended for businesses and is not directed to children under the applicable legal age in
            their jurisdiction.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">14. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. The latest version will always be available at
            [yourdomain.com/privacy-policy] with the effective date shown at the top.
          </p>
        </section>
      </div>
    </div>
  );
}
