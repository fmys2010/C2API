import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { ThemeScript } from "@/components/theme-script";

export const metadata: Metadata = {
  title: "chatgpt2api 管理面板",
  description: "ChatGPT 账号池与 OpenAI 标准接口代理的管理面板",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1113" },
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
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
