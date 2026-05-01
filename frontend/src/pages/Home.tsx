import { Inbox, Layers, Sparkles, Zap } from 'lucide-react';
import LegalFooter from '@/components/layouts/LegalFooter';
import { AIFlowVisualization } from '@/components/landing/AIFlowVisualization';
import { cn } from '@/lib/utils';

function SectionTitle({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="font-landing text-[11px] font-semibold uppercase tracking-[0.22em] text-[#5c5a55]">
        {eyebrow}
      </p>
      <h2 className="font-landing mt-4 text-3xl font-bold leading-[1.15] tracking-[-0.035em] text-[#141413] sm:text-[2.35rem]">
        {title}
      </h2>
      <p className="font-landing mt-4 text-base font-normal leading-relaxed text-[#66635e]">
        {subtitle}
      </p>
    </div>
  );
}

const steps = [
  {
    icon: Inbox,
    title: 'Every channel, one inbox',
    body: 'Messages from WhatsApp, social, and other connected channels arrive in a single thread so nothing gets lost between tabs.',
  },
  {
    icon: Layers,
    title: 'Context is assembled automatically',
    body: 'We combine the conversation, your product catalog, policies, and business settings so the model answers with your real inventory and tone.',
  },
  {
    icon: Sparkles,
    title: 'The assistant drafts the reply',
    body: 'The AI proposes a response you can send as-is or edit—keeping humans in control while removing busywork.',
  },
  {
    icon: Zap,
    title: 'Back to the customer, fast',
    body: 'Approved replies go out on the same channel, so the customer sees one continuous, natural conversation.',
  },
];

export default function HomePage() {
  return (
    <div className="font-landing min-h-screen bg-[#F0EEE6] text-[#141413] antialiased">
      <main>
        <section className="relative overflow-hidden px-6 pb-20 pt-16 sm:pb-28 sm:pt-20">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_90%_70%_at_50%_-15%,rgba(20,20,19,0.06),transparent)]" />
          <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(rgba(20,20,19,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(20,20,19,0.03)_1px,transparent_1px)] [background-size:48px_48px]" />

          <div className="relative mx-auto max-w-6xl">
            <div className="mx-auto max-w-3xl text-center">
              <p className="font-landing text-[11px] font-bold uppercase tracking-[0.28em] text-[#8b8680]">
                Hillside
              </p>
              <h1 className="font-landing mt-5 text-[2.35rem] font-bold leading-[1.08] tracking-[-0.045em] text-[#141413] sm:text-5xl sm:leading-[1.05] md:text-[3.15rem]">
                Customer conversations, answered with clarity.
              </h1>
              <p className="mx-auto mt-6 max-w-xl text-lg font-normal leading-relaxed text-[#66635e]">
                Hillside brings every message into one place, enriches it with your business data, and helps your team
                respond with AI that sounds like you—not a generic bot.
              </p>
            </div>

            <div className="mx-auto mt-14 max-w-5xl sm:mt-20">
              <AIFlowVisualization />
            </div>
          </div>
        </section>

        <section className="border-t border-[#d8d4ca] bg-[#E8E4DA] px-6 py-20 sm:py-28">
          <SectionTitle
            eyebrow="How it works"
            title="From first message to final reply"
            subtitle="The same flow your team uses in production—visualized so everyone understands how customer data moves through the system."
          />
          <div className="mx-auto mt-16 grid max-w-6xl gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ icon: Icon, title, body }, i) => (
              <article
                key={title}
                className="group rounded-2xl border border-[#d0ccc2] bg-[#F0EEE6] p-6 shadow-[0_1px_0_rgba(20,20,19,0.05)] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#d0ccc2] bg-white text-[#141413] shadow-sm transition-colors group-hover:border-[#141413]/25">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
                </div>
                <p className="font-landing mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#8b7355]">
                  Step {i + 1}
                </p>
                <h3 className="font-landing mt-2 text-lg font-bold leading-snug tracking-[-0.03em] text-[#141413]">
                  {title}
                </h3>
                <p className="mt-2 text-sm font-normal leading-relaxed text-[#66635e]">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-3xl rounded-[1.75rem] border border-[#d0ccc2] bg-gradient-to-b from-white via-white to-[#F0EEE6] px-8 py-14 text-center shadow-[0_20px_60px_-28px_rgba(20,20,19,0.12)] sm:px-12">
            <h2 className="font-landing text-3xl font-bold leading-tight tracking-[-0.04em] text-[#141413] sm:text-4xl">
              Built for the businesses we partner with
            </h2>
            <p className="mt-5 leading-relaxed text-[#66635e]">
              Hillside isn&apos;t a public signup product. We onboard clients directly, configure your channels and AI
              with your team, and provide access when you&apos;re ready to go live.
            </p>
          </div>
        </section>
      </main>

      <div className="mx-auto max-w-6xl px-6 pb-10">
        <LegalFooter
          className={cn(
            'mt-0 border-t border-[#d8d4ca] pt-8 text-[#66635e]',
            '[&_a]:text-[#66635e] [&_a:hover]:text-[#141413]',
          )}
        />
      </div>
    </div>
  );
}
