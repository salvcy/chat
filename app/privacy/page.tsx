import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy · Chat",
  description: "How Chat handles account, conversation, and model data.",
};

const sections = [
  {
    title: "What is collected",
    body: (
      <>
        <p>
          If you create an account, we store your name, email address,
          self-declared date of birth, email-verification state, sessions, and
          basic security metadata such as IP address and user agent. The date
          of birth is used to enforce the 18+ requirement.
        </p>
        <p>
          An account is required to use the app. Conversations, app settings,
          and your OpenRouter key are stored on our servers, and for
          email-and-password accounts every one of them is encrypted in your
          browser before it is sent — using a key derived from your password,
          which we never receive. Generated images and attachments are
          encrypted the same way and stored as opaque objects.
        </p>
        <p>
          What is <em>not</em> encrypted is the shape of your usage, because
          the service has to sort and group it to show you a conversation
          list: how many conversations you have, how many messages are in
          each, their order, when each was last changed, and which are
          pinned. Conversation titles, message contents, system prompts, model
          choices, and settings are never visible to us. A complete copy of
          our database would show that you had a conversation, and nothing
          about what it was.
        </p>
      </>
    ),
  },
  {
    title: "How model requests work",
    body: (
      <p>
        Model requests travel directly from your browser to OpenRouter using
        the key you provide. OpenRouter and the model provider selected for a
        request receive the prompt, relevant conversation context, and any
        attachment you send to that model. Those services apply their own
        privacy and retention terms. Our Worker does not proxy or log model
        prompts.
      </p>
    ),
  },
  {
    title: "Why data is used",
    body: (
      <p>
        We use account data to authenticate you, enforce the adult-only gate,
        synchronize encrypted app data, prevent abuse, provide account
        deletion, and operate and secure the service. We do not sell personal
        information, run behavioral advertising, or use conversation content
        to train models.
      </p>
    ),
  },
  {
    title: "Infrastructure and disclosure",
    body: (
      <p>
        Cloudflare provides hosting, D1 database storage, R2 object storage,
        realtime connection infrastructure, and network security. Information
        may also be disclosed when required by law or when necessary to
        protect the service and its users. End-to-end encrypted content cannot
        be decrypted by the service operator, but account identity and usage
        metadata are not end-to-end encrypted.
      </p>
    ),
  },
  {
    title: "Retention and deletion",
    body: (
      <p>
        Account data is retained while your account exists. Choosing “delete
        account” removes the account, sessions, conversations, messages,
        settings, and stored files associated with it. Deleting a single
        conversation removes its messages and files immediately. Copies
        already sent to OpenRouter or a model provider are governed by those
        providers.
      </p>
    ),
  },
  {
    title: "Your choices",
    body: (
      <p>
        You can remove your OpenRouter key, sign out, export individual
        conversations as Markdown or JSON, delete a conversation, or delete
        your account outright. Depending on where you live, you may also have
        rights to access, correct, or erase personal information and to object
        to or restrict certain processing.
      </p>
    ),
  },
  {
    title: "Cookies, local storage, and age",
    body: (
      <p>
        Authentication uses secure, HTTP-only session cookies. Your
        conversations are not stored in this browser. What is kept here is a
        non-extractable encryption key by default, held so you do not have to
        re-enter your password on every visit; you can instead choose “lock on
        exit,” which keeps that key in memory only. A single preferences entry
        holds your appearance, sidebar geometry, and that device-security
        choice, and the browser cache may hold OpenRouter&apos;s public model list.
        Your OpenRouter key is not written to browser storage. The service is
        intended only for people who are at least 18 years old.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    // `body` is `overflow: hidden` so the chat shell can own its own scroll
    // region. This page is an ordinary document taller than the viewport, so
    // it has to be its own scroller or it simply cannot be read past the fold.
    <main className="h-[100dvh] overflow-y-auto bg-background px-6 py-10 text-foreground sm:px-10 sm:py-16">
      <article className="mx-auto max-w-[680px]">
        <nav className="mb-14 flex items-center justify-between border-b border-hairline pb-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
          <Link href="/" className="transition-colors hover:text-foreground">
            ← chat
          </Link>
          <span>legal / 01</span>
        </nav>

        <header className="mb-14">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
            effective august 25, 2026
          </p>
          <h1 className="mt-3 text-3xl font-medium tracking-[-0.035em] sm:text-4xl">
            Privacy, in plain language.
          </h1>
          <p className="mt-5 max-w-[610px] text-[15px] leading-7 text-secondary">
            This policy explains how the Chat service at chat.belayet.co
            handles information. The short version: account identity lives on
            the service, password-account chat data is encrypted before sync,
            and model requests go directly from your browser to OpenRouter.
          </p>
        </header>

        <div className="divide-y divide-hairline border-y border-hairline">
          {sections.map((section, index) => (
            <section key={section.title} className="grid gap-4 py-8 sm:grid-cols-[42px_1fr]">
              <span className="font-mono text-[10px] text-muted">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h2 className="text-[15px] font-medium">{section.title}</h2>
                <div className="mt-3 space-y-3 text-[14px] leading-6 text-secondary">
                  {section.body}
                </div>
              </div>
            </section>
          ))}
        </div>

        <footer className="py-10 text-[13px] leading-6 text-secondary">
          <p>
            Questions or privacy requests can be sent to{" "}
            <a
              href="mailto:privacy@belayet.co"
              className="text-foreground underline decoration-hairline underline-offset-4"
            >
              privacy@belayet.co
            </a>
            . This policy may change as the service changes; the effective date
            above will be updated when it does.
          </p>
        </footer>
      </article>
    </main>
  );
}
