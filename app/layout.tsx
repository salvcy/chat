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
        {/* Pre-paint: theme and rail geometry are applied before the first
            frame so neither the palette nor a resized sidebar flashes. Keep
            the storage keys in sync with ThemeToggle and lib/preferences.ts. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement;var t=localStorage.getItem('dial:theme')||'dark';d.classList.toggle('dark',t==='dark');var r=JSON.parse(localStorage.getItem('dial:rail')||'{}');var w=Math.min(460,Math.max(180,Math.round(r.width||272)));d.style.setProperty('--dial-rail-w',w+'px');d.classList.toggle('dial-rail-collapsed',r.collapsed===true)}catch(e){document.documentElement.classList.add('dark')}`,
          }}
        />
      </head>
      <body className="h-full bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
