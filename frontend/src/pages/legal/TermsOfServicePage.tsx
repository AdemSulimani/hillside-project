const EFFECTIVE_DATE = 'April 15, 2026';
const LAST_UPDATED = 'April 15, 2026';

export default function TermsOfServicePage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective Date: {EFFECTIVE_DATE}</p>
      <p className="text-sm text-muted-foreground">Last Updated: {LAST_UPDATED}</p>

      <div className="mt-8 space-y-8 text-sm leading-6 text-foreground">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">1. Service Description</h2>
          <p>
            [Your Company Legal Name] (&quot;Company&quot;, &quot;we&quot;, &quot;us&quot;) provides [Platform Name], a cloud-based customer
            messaging and sales automation platform. These Terms govern your access to and use of our platform and
            related services.
          </p>
          <p>By creating an account or using the platform, you agree to these Terms.</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">2. Eligibility and Account Responsibilities</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>You must be at least 18 years old and authorized to bind your business.</li>
            <li>You must provide accurate account and billing information.</li>
            <li>You are responsible for account security and all activity under your account.</li>
            <li>
              You must notify us promptly at [support@yourdomain.com] if you suspect unauthorized access.
            </li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">3. Acceptable Use</h2>
          <p>You may not use the platform to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Send spam, unlawful communications, or abusive content.</li>
            <li>Impersonate others or misrepresent affiliations.</li>
            <li>Harass, threaten, or defraud others.</li>
            <li>Attempt unauthorized access to systems or data.</li>
            <li>
              Use bots, scripts, scraping, or automation against our platform infrastructure, except as expressly
              allowed by our documentation.
            </li>
            <li>Reverse engineer, sublicense, or resell the platform without written permission.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">4. Messaging and Compliance Obligations</h2>
          <p>When using messaging features, you agree that:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>You are responsible for compliance with applicable communications, privacy, and consumer laws.</li>
            <li>You will only message people with required legal consent or lawful basis where required.</li>
            <li>You will provide and honor opt-out requests promptly.</li>
            <li>You will not use the platform for unsolicited bulk outreach or prohibited promotional abuse.</li>
            <li>You are responsible for business accuracy of pricing, orders, and customer-facing commitments.</li>
            <li>You will review AI outputs where errors could materially affect customers.</li>
          </ul>
          <p>
            You may only use Meta Platform Data obtained through our service for permitted messaging and customer
            support purposes, and not for unauthorized profiling, resale, surveillance, or unrelated advertising.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">5. Third-Party Platform Terms (Meta)</h2>
          <p>
            Our integrations with Facebook, Instagram, and WhatsApp Business (including the WhatsApp Business Platform /
            Cloud API) are subject to Meta terms and policies. You are responsible for complying with all applicable Meta
            requirements for your use case.
          </p>
          <p>
            Facebook and Instagram connections are offered as separate authorization flows. Connecting one channel does
            not automatically connect the other, and Instagram Login in our current flow is intended to operate
            independently from Facebook Page connection, subject to Meta platform requirements and account configuration.
          </p>
          <p>
            You may also integrate WhatsApp Business as a separate channel. WhatsApp Business authorization and usage
            permissions are managed independently from Facebook and Instagram connections.
          </p>
          <p>
            If Meta changes APIs, permissions, or policies, you agree to cooperate with reasonable implementation
            changes needed to maintain compliance and service continuity.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">6. AI Disclaimer</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>AI outputs may be inaccurate, incomplete, or unsuitable in specific contexts.</li>
            <li>You remain responsible for final customer communications sent through your business channels.</li>
            <li>We do not guarantee specific commercial outcomes from AI features.</li>
            <li>AI outputs are not legal, financial, medical, or other professional advice.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">7. Data Processing and Privacy</h2>
          <p>
            Our processing of personal data is described in our Privacy Policy at [yourdomain.com/privacy-policy], which
            is incorporated by reference.
          </p>
          <p>
            We use service providers under written agreements to operate the platform and protect data. If you require
            a Data Processing Agreement, contact [privacy@yourdomain.com].
          </p>
          <p>
            You agree to reasonably cooperate with valid deletion, correction, and platform-data requests required by
            applicable law or platform policy.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">8. Availability and Changes</h2>
          <p>
            We aim to provide reliable service but do not guarantee uninterrupted availability. Service interruptions
            may occur due to maintenance, outages, or third-party dependencies.
          </p>
          <p>We may modify features from time to time and will provide reasonable notice for material changes.</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">9. Fees and Billing</h2>
          <p>
            Pricing, billing cadence, and any usage-based fees are described in your applicable order form, plan page,
            or subscription terms.
          </p>
          <p>
            Unless required by law, fees are non-refundable. We may update pricing with prior notice as required by
            applicable law or contract.
          </p>
          <p>
            Where your commercial plan includes commission-based billing, we may mark an order as completed when AI has
            fully completed that order workflow according to configured logic. In those cases, our admin dashboard may
            generate an internal completion notification that includes the relevant company identifier, and a 5%
            commission may be applied to that completed order where stated in your plan or order form.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">10. Intellectual Property</h2>
          <p>
            We retain all rights in the platform and underlying software. You retain rights to your business content.
            You grant us a limited license to process your content only to provide and secure the service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">11. Termination</h2>
          <p>You may stop using the platform at any time.</p>
          <p>
            We may suspend or terminate access for material violations, legal risk, non-payment, security threats, or
            misuse that jeopardizes platform integrity or third-party integrations.
          </p>
          <p>
            After termination, data handling follows our Privacy Policy and legal obligations, including applicable
            retention and deletion timelines.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">12. Disclaimers</h2>
          <p>
            The platform is provided &quot;as is&quot; and &quot;as available,&quot; to the fullest extent permitted by law. We disclaim
            implied warranties, including merchantability, fitness for a particular purpose, and non-infringement.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">13. Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, we are not liable for indirect, incidental, special, consequential,
            or punitive damages.
          </p>
          <p>
            Our total liability for claims arising from the service will not exceed the greater of (a) fees paid by you
            to us in the 12 months before the claim or (b) $100, unless a different limit is required by law.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">14. Indemnification</h2>
          <p>
            You agree to defend and indemnify [Your Company Legal Name] against claims arising from your unlawful use
            of the platform, violation of these Terms, or infringement of third-party rights.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">15. Governing Law and Disputes</h2>
          <p>
            These Terms are governed by the laws of [Your Country/State], excluding conflict-of-law rules. Disputes
            will be handled in [your chosen forum and process], unless applicable law requires otherwise.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">16. Contact and Notices</h2>
          <p>
            Support: [support@yourdomain.com]
            <br />
            Privacy: [privacy@yourdomain.com]
            <br />
            Legal: [legal@yourdomain.com]
            <br />
            Address: [Full legal address]
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">17. General</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>These Terms and the Privacy Policy form the complete agreement for use of the platform.</li>
            <li>If one provision is unenforceable, the remaining provisions remain in effect.</li>
            <li>Failure to enforce a provision is not a waiver.</li>
            <li>You may not assign rights under these Terms without our consent.</li>
            <li>
              We are not liable for delays caused by events beyond reasonable control, including third-party platform
              outages.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
