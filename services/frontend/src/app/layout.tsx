import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

/**
 * globals.css references `--font-inter` and `--font-jetbrains-mono` in its
 * `--font-sans` / `--font-mono` token definitions. Those variables only exist
 * if the fonts are loaded here, so this is not decoration: without it the whole
 * type system silently falls back to the system stack.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Guild Moderation Watcher",
    template: "%s · GMW",
  },
  description:
    "Live AI moderation monitoring for a Discord guild: verdicts, queue health, and enforcement activity.",
  // The dashboard is not indexed; it is a private operations surface.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0a09" },
  ],
  width: "device-width",
  initialScale: 1,
  // The mobile dock sits at the bottom; without this, iOS can scroll the page
  // so the dock hides the browser chrome.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
