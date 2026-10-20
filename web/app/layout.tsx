import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chat",
  description: "A minimal chat interface for every model, through one key.",
  /*
   * Versioned paths, not the `app/icon.*` file convention.
   *
   * Browsers cache favicons by site in their own store and do not reliably
   * refetch when only a query string changes — after the mark changed, a
   * browser that had seen the create-next-app default kept showing it. A new
   * path is the one thing every browser treats as a new icon, so bump the
   * `-v` suffix whenever the mark changes. The SVG inverts under a dark
   * browser theme so the tile never disappears into a dark tab strip.
   */
  icons: {
    icon: [
      { url: "/brand/chat-mark-v2.svg", type: "image/svg+xml" },
      { url: "/brand/chat-mark-v2-32.png", sizes: "32x32", type: "image/png" },
    ],
    shortcut: "/favicon.ico",
    apple: { url: "/brand/chat-mark-v2-180.png", sizes: "180x180" },
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/* Pre-paint: appearance and rail geometry are applied before the
            first frame, so nothing flashes the wrong theme, typeface or
            column width on load. This duplicates a little of lib/settings.ts
            on purpose — it has to be inline and synchronous, and it cannot
            import. Keep the two in sync; `dial:appearance` is the contract.

            This is the *only* thing left that reads localStorage, and it is
            why one key survived the move to a cloud-only store: the sealed
            settings blob cannot be opened until after sign-in, and waiting
            for that would mean painting the default theme on every load and
            then snapping to the real one. The same entry also carries the
            non-sensitive remember/lock device preference; this script ignores
            it. There are no ids or credentials here. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement;var k=window.__CHAT_DESKTOP__;if(k&&k.platform)d.dataset.shell=k.platform;var s=JSON.parse(localStorage.getItem('dial:appearance')||'{}');var t=s.theme||'dark';var dark=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);d.classList.toggle('dark',dark);d.dataset.themeChoice=t;var F={geist:'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',system:'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',serif:'ui-serif, Georgia, Cambria, "Times New Roman", serif'};var S={small:'0.9375',medium:'1',large:'1.0937'};var W={narrow:'640px',medium:'760px',wide:'920px'};var G={comfortable:'2.25rem',compact:'1.5rem'};d.style.setProperty('--dial-font',F[s.font]||F.geist);d.style.setProperty('--dial-text-scale',S[s.textSize]||S.medium);d.style.setProperty('--dial-column',W[s.width]||W.medium);d.style.setProperty('--dial-row-gap',G[s.density]||G.comfortable);var w=Math.min(460,Math.max(180,Math.round(s.railWidth||272)));d.style.setProperty('--dial-rail-w',w+'px');d.classList.toggle('dial-rail-collapsed',s.railCollapsed===true);var O=['newchat','chat','signin','unlock','connect'];d.dataset.ocean=s.ocean===false?'':(Array.isArray(s.oceanPlaces)?O.filter(function(p){return s.oceanPlaces.indexOf(p)>=0}):['newchat','signin','unlock','connect']).join(' ')}catch(e){document.documentElement.classList.add('dark')}`,
          }}
        />
      </head>
      <body className="h-full bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
