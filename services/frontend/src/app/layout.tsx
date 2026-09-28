import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
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
  // The colours are the two --canvas-base values from globals.css, so the
  // browser chrome matches whatever theme resolved.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0f2f5" },
    { media: "(prefers-color-scheme: dark)", color: "#060709" },
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
    /*
     * `suppressHydrationWarning` on <html> is required and is not papering
     * over a bug: next-themes writes the theme class onto this element from a
     * blocking inline script, before React hydrates, so the server's markup
     * and the client's first render legitimately differ for one attribute.
     */
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        {/*
         * ThemeProvider must sit INSIDE <body>: next-themes injects its
         * no-flash script as a child of the component it wraps, and that script
         * has to run before first paint. Mounting it around <html> would place
         * a <script> outside the body and flash the wrong theme on first load.
         *
         * attribute="class" is what makes the `dark:` variants in the shadcn
         * primitives and the .dark token block in globals.css apply.
         */}
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
