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
          Conversations, app settings, and your OpenRouter key sync only when
          you sign in. Email-and-password accounts encrypt that material in
          your browser before it is sent. Generated images and attachments are
          likewise encrypted in the browser and stored as opaque R2 objects.
          Without an account, chat history remains in your browser only.
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
        account” removes the account, sessions, synchronized records,
        settings, and R2 blobs associated with it. Copies already sent to
        OpenRouter or a model provider are governed by those providers. Local
        browser data can be removed by signing out with device wipe enabled or
        by clearing this site&apos;s storage.
      </p>
    ),
  },
  {
    title: "Your choices",
    body: (
      <p>
        You can use the app without an account, remove your OpenRouter key,
        sign out and wipe a device, export individual conversations, or delete
        your account. Depending on where you live, you may also have rights to
        access, correct, or erase personal information and to object to or
        restrict certain processing.
      </p>
    ),
  },
  {
    title: "Cookies, local storage, and age",
    body: (
      <p>
        Authentication uses secure, HTTP-only session cookies. IndexedDB and
        local storage hold local conversations, a non-extractable encryption
        key, interface preferences, sync cursors, and—if you choose—your
        OpenRouter credential. The service is intended only for people who are
        at least 18 years old.
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
