import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { ThemeScript } from "@/components/theme-script";
import { TopNav } from "@/components/top-nav";

export const metadata: Metadata = {
  title: "ChatGPT2API · Codex & Antigravity Edition",
  description: "High-performance ChatGPT account pool & OpenAI standard API proxy dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#08090d" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="dark">
      <head>
        <ThemeScript />
      </head>
      <body
        className="min-h-screen bg-[#f8fafc] text-zinc-900 antialiased selection:bg-emerald-500/20 selection:text-emerald-400 dark:bg-[#08090d] dark:text-zinc-100"
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        <Toaster position="top-center" richColors offset={48} theme="dark" />
        <div className="flex min-h-screen flex-col">
          <TopNav />
          <main className="flex-1 px-3 py-3 sm:px-5 sm:py-4">
            <div className="mx-auto max-w-[1680px] space-y-3 sm:space-y-4">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
