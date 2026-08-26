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
            import. Keep the two in sync; the storage keys are the contract. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement;var s=JSON.parse(localStorage.getItem('dial:settings')||'{}');var t=s.theme||localStorage.getItem('dial:theme')||'dark';var dark=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);d.classList.toggle('dark',dark);d.dataset.themeChoice=t;var F={geist:'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',system:'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',serif:'ui-serif, Georgia, Cambria, "Times New Roman", serif'};var S={small:'0.9375',medium:'1',large:'1.0937'};var W={narrow:'640px',medium:'760px',wide:'920px'};var G={comfortable:'2.25rem',compact:'1.5rem'};d.style.setProperty('--dial-font',F[s.font]||F.geist);d.style.setProperty('--dial-text-scale',S[s.textSize]||S.medium);d.style.setProperty('--dial-column',W[s.width]||W.medium);d.style.setProperty('--dial-row-gap',G[s.density]||G.comfortable);var r=JSON.parse(localStorage.getItem('dial:rail')||'{}');var w=Math.min(460,Math.max(180,Math.round(r.width||272)));d.style.setProperty('--dial-rail-w',w+'px');d.classList.toggle('dial-rail-collapsed',r.collapsed===true)}catch(e){document.documentElement.classList.add('dark')}`,
          }}
        />
      </head>
      <body className="h-full bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
