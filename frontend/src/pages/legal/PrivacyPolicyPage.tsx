import { Link } from 'react-router-dom';

const EFFECTIVE_DATE = 'April 14, 2026';
const LAST_UPDATED = 'May 10, 2026';

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">Effective Date: {EFFECTIVE_DATE}</p>
      <p className="text-sm text-muted-foreground">Last Updated: {LAST_UPDATED}</p>

      <div className="mt-6 rounded-lg border border-border bg-muted/40 p-4 sm:p-5">
        <h2 className="text-base font-semibold text-foreground">Data deletion requests</h2>
        <p className="mt-2 text-sm leading-6 text-foreground">
          To request deletion of personal data, email{' '}
          <a href="mailto:privacy@byhillside.com" className="font-medium text-primary underline">
            privacy@byhillside.com
          </a>
          . Step-by-step instructions are on our{' '}
          <Link to="/data-deletion" className="font-medium text-primary underline">
            Data deletion requests
          </Link>{' '}
          page.
        </p>
      </div>

      <div className="mt-8 space-y-8 text-sm leading-6 text-foreground">
        <section className="space-y-3">
          <p>
            This Privacy Policy describes how Hillside L.L.C. (&quot;Hillside&quot;, &quot;we&quot;, &quot;us&quot;, or
            &quot;our&quot;) collects, uses, discloses, and handles personal data in connection with the Hillside
            platform and related services. It applies to: (a) business customers and authorized users who access the
            platform; and (b) to the extent applicable, end users whose data is processed through the platform on
            behalf of our business customers.
          </p>
          <p>
            For questions about this Privacy Policy or to exercise your rights, contact us at:
            <br />
            Email: privacy@byhillside.com
            <br />
            Address: St. Ndue Përlleshi, 207, Floor 2, No. 8, Matiçan, Pristina, Kosovo
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">1. Who We Are</h2>
          <p>
            Hillside L.L.C. is a limited liability company registered in Kosovo. We operate Hillside, an AI-powered
            social messaging and sales automation platform for businesses. For the purposes of applicable data
            protection law, Hillside is the data controller with respect to account and platform data of our business
            customers and their authorized users. With respect to end-user data processed through the platform on
            behalf of business customers (including Meta Platform Data), Hillside acts as a data processor operating
            under the instructions of the relevant business customer.
          </p>
          <p>
            Data Deletion: To request deletion of your personal data, contact privacy@byhillside.com with the subject
            line &quot;Data Deletion Request&quot;. For Meta Platform Data, use the subject line &quot;Meta Data
            Deletion Request&quot;. We will process requests in accordance with applicable law and Meta platform
            requirements.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">2. Data We Collect</h2>
          <h3 className="text-base font-semibold">2.1 Account and Business Data</h3>
          <p>When you register and configure your account, we collect:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>business and account holder identifiers: name, email address, business name, and profile details;</li>
            <li>
              onboarding and configuration data: platform setup preferences, business settings, and feature
              configurations.
            </li>
          </ul>

          <h3 className="text-base font-semibold">2.2 Connected Channel Data</h3>
          <p>When you connect Meta channels to the platform, we collect:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>channel identifiers: Facebook Page IDs, Instagram account IDs, and WhatsApp Business phone number IDs;</li>
            <li>
              access credentials: encrypted OAuth tokens and authorization credentials necessary to send and receive
              messages through connected channels; and
            </li>
            <li>channel configuration settings: per-channel feature settings and integration parameters.</li>
          </ul>

          <h3 className="text-base font-semibold">2.3 Message and Conversation Data</h3>
          <p>When your connected channels receive or send messages, we process:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>inbound and outbound message content, including text, attachments, and media;</li>
            <li>sender and recipient platform identifiers (as provided by the Meta API);</li>
            <li>message timestamps and delivery metadata; and</li>
            <li>conversation history and thread context necessary to provide reply and automation functionality.</li>
          </ul>

          <h3 className="text-base font-semibold">2.4 Order and Contact Data</h3>
          <p>In connection with order automation workflows, we collect:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              customer contact details provided during conversations (e.g., name, delivery address, contact
              information) as entered or confirmed by the end user in the course of a transaction;
            </li>
            <li>order records and associated product information; and</li>
            <li>
              order status data, including system-determined order completion status used for workflow automation and
              commission calculation.
            </li>
          </ul>

          <h3 className="text-base font-semibold">2.5 Billing Event and Commission Data</h3>
          <p>For commission arrangements, we generate and retain:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              system-generated records of billable events, including confirmed order completions and resolved support
              cases;
            </li>
            <li>commission calculation data, including applicable rates and business account identifiers; and</li>
            <li>internal administrative notifications and audit logs related to billing events.</li>
          </ul>

          <h3 className="text-base font-semibold">2.6 Product Catalog and AI Configuration Data</h3>
          <p>We collect:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              product catalog data: names, descriptions, pricing, and availability settings you upload or configure;
              and
            </li>
            <li>
              AI configuration settings: AI tone preferences, response restrictions, workflow logic, and related
              configurations.
            </li>
          </ul>

          <h3 className="text-base font-semibold">2.7 Usage and Security Logs</h3>
          <p>We collect technical and operational data including:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>IP addresses, browser type, device identifiers, and operating system information;</li>
            <li>access and session events, login history, and authentication records; and</li>
            <li>platform usage activity, feature interaction logs, and error reports.</li>
          </ul>

          <h3 className="text-base font-semibold">2.8 AI Feedback Data</h3>
          <p>Where you or your authorized users submit corrections or ratings on AI-generated responses, we collect:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>feedback content and the associated AI output; and</li>
            <li>where necessary for model improvement, the message context associated with the AI output.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">3. Sources of Data</h2>
          <p>We collect personal data from the following sources:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Directly from you: through account registration, onboarding, product configuration, support requests, and
              in-platform settings.
            </li>
            <li>
              From Meta Platforms: through the Facebook Graph API, Instagram Graph API, and WhatsApp Business Cloud
              API, via webhooks and API calls initiated when your connected channels receive or send customer messages.
            </li>
            <li>
              From your use of the platform: through your interactions with platform features, dashboards, and
              settings.
            </li>
            <li>
              From your customers: customer data is provided during conversations and order workflows within your
              connected channels, and is processed on your behalf as the business customer.
            </li>
          </ul>
          <p>
            If you disconnect a Meta channel or third-party integration from the platform, we will cease ongoing
            collection of data from that source. Data previously collected will be retained and processed in accordance
            with this Privacy Policy and applicable legal obligations, unless you request deletion as described in
            Section 12.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">4. Meta Platform Data: Processing Principles</h2>
          <p>
            This section sets out Hillside&apos;s specific obligations and commitments with respect to data obtained
            from Meta&apos;s platforms through API access (&quot;Meta Platform Data&quot;), in accordance with Meta
            Platform Terms and Developer Policies.
          </p>
          <h3 className="text-base font-semibold">4.1 Processor Role</h3>
          <p>
            Hillside processes Meta Platform Data solely as a data processor on behalf of, and under the instructions
            of, our business customers. Hillside does not independently determine the purposes or means of processing
            Meta Platform Data beyond what is necessary to deliver the services requested by the business customer.
          </p>
          <h3 className="text-base font-semibold">4.2 Permitted Use</h3>
          <p>Meta Platform Data is processed exclusively to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>deliver inbound and outbound messaging functionality through your connected Meta channels;</li>
            <li>generate AI-assisted responses and support sales automation workflows authorized by you;</li>
            <li>provide customer support and inbox management features; and</li>
            <li>
              enable analytics, quality monitoring, and service improvement features within the scope of your
              configured account.
            </li>
          </ul>
          <h3 className="text-base font-semibold">4.3 Prohibited Uses of Meta Platform Data</h3>
          <p>Hillside expressly does not, and will not:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>sell, license, or transfer Meta Platform Data to any third party for their independent use;</li>
            <li>
              use Meta Platform Data for advertising, retargeting, or marketing purposes unrelated to the specific
              business interaction through which the data was collected;
            </li>
            <li>
              create or contribute to independent user profiles by combining Meta Platform Data with data from other
              businesses or external sources;
            </li>
            <li>
              aggregate Meta Platform Data across multiple business customers for purposes of cross-business analytics,
              profiling, or data monetization;
            </li>
            <li>
              use Meta Platform Data for credit scoring, fraud scoring unrelated to platform security, surveillance, or
              law enforcement purposes (except where required by law); or
            </li>
            <li>
              use Meta Platform Data in any manner inconsistent with the specific permissions granted by the end user
              or business customer.
            </li>
          </ul>
          <h3 className="text-base font-semibold">4.4 Messaging Initiation</h3>
          <p>
            All automated or AI-assisted messaging through Meta channels is initiated, configured, or explicitly
            authorized by the business customer. The platform does not autonomously initiate outbound communications
            with end users outside of the workflows, message templates, and configurations established by the business
            customer. Business customers are responsible for ensuring that all automated communications comply with
            applicable Meta messaging policies, including opt-in requirements and permitted message windows.
          </p>
          <h3 className="text-base font-semibold">4.5 Data Segregation</h3>
          <p>
            Meta Platform Data is processed on a per-business-customer basis. Data from one business customer&apos;s
            connected channels is not shared with, aggregated with, or used to benefit any other business customer.
            Each authorized Meta channel integration is processed independently within the scope of the specific
            permissions granted by the business customer.
          </p>
          <h3 className="text-base font-semibold">4.6 AI Processing of Meta Platform Data</h3>
          <p>
            Message content and related metadata obtained through Meta channels may be processed by AI providers acting
            as Hillside&apos;s authorized subprocessors. Such processing is limited to generating AI-assisted replies,
            detecting purchase intent, supporting order workflows, and conducting quality checks&mdash;all on behalf of the
            relevant business customer. AI providers are bound by written agreements that restrict their use of the
            data to providing services on Hillside&apos;s behalf.
          </p>
          <p>
            Hillside does not use Meta Platform Data to train general-purpose or unrelated machine learning models; Meta
            Platform Data is processed only to provide the platform services described in this Policy and for
            improvements permitted under Meta Platform Terms and our agreements with subprocessors.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">5. Cookies and Similar Technologies</h2>
          <h3 className="text-base font-semibold">5.1 Authentication Cookies</h3>
          <p>
            We use HTTP-only session cookies to manage authentication and maintain your login state. These cookies are
            strictly necessary for platform security and are not used for advertising or behavioral tracking.
          </p>
          <h3 className="text-base font-semibold">5.2 Browser Storage</h3>
          <p>
            Certain platform features may store session tokens or operational data in browser local storage to enable
            specific application functionality. This is limited to operational use within the platform.
          </p>
          <h3 className="text-base font-semibold">5.3 No Third-Party Advertising Cookies</h3>
          <p>
            We do not use third-party advertising cookies, behavioral tracking pixels, or cross-site tracking
            technologies in the platform as currently operated. If this changes, we will update this Privacy Policy,
            provide appropriate notice, and implement required consent mechanisms.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">6. Purposes and Legal Bases for Processing</h2>
          <h3 className="text-base font-semibold">6.1 Purposes</h3>
          <p>We process personal data for the following purposes:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Providing the platform: enabling channel connection, inbox management, AI-assisted reply, order workflow
              automation, and related features.
            </li>
            <li>
              Commission calculation and settlement support: calculating commission amounts from billable events (such
              as confirmed orders); maintaining commission and billing records; and preparing or sharing invoicing
              information as agreed. The platform does not process payments; commission is settled outside the platform
              (for example, via cash or bank transfer).
            </li>
            <li>
              Security and fraud prevention: authenticating users, monitoring for unauthorized access, and maintaining
              platform integrity.
            </li>
            <li>Customer support: responding to account inquiries and resolving platform issues.</li>
            <li>
              Service improvement: using AI feedback data, usage logs, and anonymized analytics to improve platform
              performance and response quality.
            </li>
            <li>Legal compliance: retaining records and fulfilling obligations under applicable law.</li>
          </ul>
          <h3 className="text-base font-semibold">6.2 Legal Basis (EU/UK Customers)</h3>
          <p>
            Where applicable data protection law (such as the GDPR or UK GDPR) requires a legal basis, we rely on:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Performance of a contract: processing necessary to provide the platform services under these Terms.</li>
            <li>
              Legitimate interests: security operations, fraud prevention, service improvement, and enforcement of our
              terms, where not overridden by your rights.
            </li>
            <li>Legal obligation: compliance with applicable laws, regulations, and legal process.</li>
            <li>Consent: where required by law, such as optional marketing communications (if any).</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">7. Disclosure of Data</h2>
          <p>We do not sell personal data. We disclose personal data only in the following circumstances:</p>
          <h3 className="text-base font-semibold">7.1 Service Providers (Subprocessors)</h3>
          <p>
            We share data with authorized subprocessors who process data on our behalf to operate and support the
            platform. All subprocessors are bound by written agreements that restrict their use of data to providing
            services on our behalf, impose data protection obligations, and prohibit use for any independent purpose.
            See Section 9 for a list of key subprocessors.
          </p>
          <h3 className="text-base font-semibold">7.2 Meta APIs</h3>
          <p>
            When you send replies or interact with customers through connected Meta channels, message content is
            transmitted via Meta&apos;s APIs as part of the platform&apos;s core functionality.
          </p>
          <h3 className="text-base font-semibold">7.3 Legal Requirements</h3>
          <p>
            We may disclose personal data when required by applicable law, valid legal process (such as a court order
            or regulatory demand), or where necessary to protect the rights, property, or safety of Hillside, our
            users, or third parties. Where legally permissible, we will notify you of such requests.
          </p>
          <h3 className="text-base font-semibold">7.4 Business Transfers</h3>
          <p>
            In connection with a merger, acquisition, reorganization, or sale of all or substantially all of our
            assets, personal data may be transferred to the successor entity, subject to appropriate confidentiality
            and data protection obligations.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">8. AI Processing and Model Improvement</h2>
          <p>
            AI-generated outputs are produced using AI infrastructure provided by our authorized subprocessors
            (including OpenAI, L.L.C.). When you or your authorized users submit feedback on AI responses, we may use
            that feedback data&mdash;and, where necessary, the associated message context&mdash;to:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>improve the accuracy and quality of AI-generated responses;</li>
            <li>fine-tune and optimize AI models used in the platform; and</li>
            <li>conduct quality assurance and monitoring of automated reply functionality.</li>
          </ul>
          <p>
            This processing is conducted in accordance with the contractual terms between Hillside and its AI
            subprocessors, which include data use restrictions applicable to the processing of customer data.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">9. Subprocessors</h2>
          <p>
            Hillside uses the following categories of authorized subprocessors to operate and support the platform. All
            subprocessors are bound by contractual data protection obligations restricting them to processing data
            solely on Hillside&apos;s behalf.
          </p>
          <p>Key Subprocessors:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              OpenAI, L.L.C. (United States): AI-generated response infrastructure, content processing, and model
              improvement features.
            </li>
            <li>
              Meta Platforms, Inc. (United States): Delivery and receipt of messages through Facebook, Instagram, and
              WhatsApp Business APIs.
            </li>
            <li>
              Cloud infrastructure and hosting providers: Application hosting, database management, and related
              infrastructure services.
            </li>
            <li>
              Monitoring and observability providers: System performance tracking, error detection, and operational
              logging.
            </li>
          </ul>
          <p>
            These providers may process data in jurisdictions outside your own, including the United States. Where
            required by applicable law, we ensure appropriate safeguards are in place (such as Standard Contractual
            Clauses or equivalent mechanisms) for international data transfers.
          </p>
          <p>
            We may update our subprocessors from time to time. Material updates to key subprocessors will be reflected
            in this Privacy Policy with a revised Effective Date.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">10. Data Retention</h2>
          <h3 className="text-base font-semibold">10.1 General Retention Principles</h3>
          <p>
            We retain personal data only for as long as necessary to fulfill the purposes described in this Privacy
            Policy, comply with applicable legal obligations, resolve disputes, enforce our agreements, and maintain
            platform security. When data is no longer required for these purposes, we securely delete or anonymize it.
          </p>
          <h3 className="text-base font-semibold">10.2 Meta Platform Data Retention</h3>
          <p>
            Meta Platform Data is retained only for as long as necessary to provide the platform&apos;s messaging,
            automation, and customer support functionality to the relevant business customer, or as required by
            applicable legal obligations. We do not retain Meta Platform Data for unrelated purposes following the
            termination of a business customer&apos;s account.
          </p>
          <h3 className="text-base font-semibold">10.3 AI Feedback Data</h3>
          <p>
            AI feedback data, including associated message context where necessary, may be retained for the purpose of
            model improvement and quality optimization, subject to applicable contractual and legal limitations. Where
            retention periods are specified in your service agreement or order, those periods govern.
          </p>
          <h3 className="text-base font-semibold">10.4 Billing Records</h3>
          <p>
            Records of billing events, commission calculations, and related invoicing or settlement documentation are
            retained for the period required by applicable tax, accounting, and commercial law, or as otherwise required
            by applicable legal obligations.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">11. Your Privacy Rights</h2>
          <p>
            Depending on your location and applicable law, you may have the following rights with respect to your
            personal data:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Access: the right to request confirmation of whether we process your personal data and to receive a copy
              of that data.
            </li>
            <li>Correction: the right to request correction of inaccurate or incomplete personal data.</li>
            <li>
              Erasure: the right to request deletion of your personal data where it is no longer necessary for the
              purposes for which it was collected, or where you withdraw consent (where consent is the legal basis).
            </li>
            <li>Restriction: the right to request restriction of processing in certain circumstances.</li>
            <li>Objection: the right to object to processing based on legitimate interests.</li>
            <li>
              Portability: the right to receive your personal data in a structured, machine-readable format where
              technically feasible.
            </li>
          </ul>
          <p>
            To exercise any of these rights, contact privacy@byhillside.com. We will respond within the timeframe
            required by applicable law (generally within 30 days under the GDPR). We may require verification of your
            identity before processing your request.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">12. Data Deletion Requests</h2>
          <h3 className="text-base font-semibold">12.1 Business Customer Requests</h3>
          <p>
            Business customers may request deletion of their account data by contacting privacy@byhillside.com. We will
            process deletion requests in accordance with our data retention obligations, applicable law, and any
            binding legal holds.
          </p>
          <h3 className="text-base font-semibold">12.2 End User Requests</h3>
          <p>
            If you are an end user whose data has been processed through a business customer&apos;s connected channels,
            you may submit a deletion request either to the relevant business directly or to Hillside at
            privacy@byhillside.com. We will assist in processing such requests within the scope of our role as data
            processor.
          </p>
          <h3 className="text-base font-semibold">12.3 Meta Platform Data Deletion</h3>
          <p>
            To submit a deletion request specifically relating to Meta Platform Data, contact privacy@byhillside.com
            with the subject line &quot;Meta Data Deletion Request&quot; and include sufficient information to identify
            your records (e.g., platform account identifier or connected channel identifier). We will process such
            requests in accordance with applicable Meta platform requirements and applicable law.
          </p>
          <h3 className="text-base font-semibold">12.4 Processing Timeframe</h3>
          <p>
            We aim to confirm receipt of deletion requests within five (5) business days and to complete processing
            within thirty (30) calendar days, except where extended timelines are required by legal or operational
            constraints.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">13. Security</h2>
          <p>
            Hillside implements appropriate technical and organizational security measures designed to protect personal
            data against unauthorized access, disclosure, alteration, or destruction. These measures include, without
            limitation:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>encrypted data transmission using TLS;</li>
            <li>access controls and authentication requirements for platform access;</li>
            <li>operational security monitoring and logging; and</li>
            <li>vendor security assessments for key subprocessors.</li>
          </ul>
          <p>
            No security measure can guarantee absolute protection. If you identify a security vulnerability or
            incident, please contact security@byhillside.com promptly.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">14. International Data Transfers</h2>
          <p>
            Personal data may be transferred to and processed in countries outside your country of residence, including
            the United States (where Meta Platforms, Inc. and OpenAI, L.L.C. are based). Where required by applicable
            data protection law, we ensure that such international transfers are conducted in accordance with
            appropriate safeguards, including Standard Contractual Clauses approved by the relevant supervisory
            authority or equivalent legally recognized transfer mechanisms.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">15. Children</h2>
          <p>
            The platform is intended exclusively for use by business entities and adult individuals operating in a
            professional capacity. The platform is not directed to, and we do not knowingly collect personal data
            from, children under the applicable minimum age in their jurisdiction (in most cases, 13 years of age, or
            16 years of age under the GDPR). If we become aware that we have inadvertently collected personal data from
            a child, we will promptly delete it.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">16. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time to reflect changes in our practices, platform features,
            or applicable law. The updated Policy will be posted at byhillside.com/privacy-policy with a revised
            Effective Date. We will provide reasonable notice of material changes (for example, by email or in-platform
            notification) before they take effect. Your continued use of the platform following the effective date of a
            revised Policy constitutes your acceptance of the changes.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">17. Contact</h2>
          <p>
            For questions, concerns, or requests related to this Privacy Policy or your data rights:
            <br />
            Hillside L.L.C.
            <br />
            St. Ndue Përlleshi, 207, Floor 2, No. 8, Matiçan, Pristina, Kosovo
            <br />
            Privacy: privacy@byhillside.com
            <br />
            Security: security@byhillside.com
          </p>
        </section>
      </div>
    </div>
  );
}
