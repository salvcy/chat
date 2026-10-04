import type { Metadata } from "next";
import Relay from "./Relay";

export const metadata: Metadata = {
  title: "Returning to Chat",
  robots: { index: false, follow: false },
};

/**
 * Where OpenRouter sends a desktop app user after they approve the
 * connection. It runs in their browser, and its only job is to pass the
 * authorization code on to the app (`lib/pkce.ts`).
 */
export default function Page() {
  return <Relay />;
}
