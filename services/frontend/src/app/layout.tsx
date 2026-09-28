import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { SwrProvider } from "@/components/providers";
import { Toaster } from "@/components/ui/toast";
import "./globals.css";

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

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "GMW — Discord Moderation Console",
  description: "AI-powered Discord moderation console",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Applied before first paint to avoid a light-mode flash; see ThemeInitScript.
const THEME_BOOTSTRAP =
  "(function(){try{var t=localStorage.getItem('theme');document.documentElement.className+=' '+(t||'dark')}catch(e){}})()";

/**
 * Applies the saved theme (or the "dark" default) before first paint, so a
 * client-side navigation or hydration never flashes light mode. It has to be an
 * inline script to run synchronously while the HTML parses -- a fetched script
 * runs after paint, which is too late. next-themes takes over once mounted.
 */
function ThemeInitScript() {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal with no interpolation, so it cannot carry user input; Next.js' "Preventing flash before hydration" guide prescribes this inline-script shape.
  return <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${bricolage.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <head>
        <ThemeInitScript />
      </head>
      <body className="noise-overlay min-h-full flex flex-col">
        <SwrProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem={false}
            enableColorScheme={false}
            disableTransitionOnChange
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </SwrProvider>
      </body>
    </html>
  );
}
