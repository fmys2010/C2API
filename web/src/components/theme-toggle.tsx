"use client";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";

export function ThemeToggle() {
  return (
    <AnimatedThemeToggler
      aria-label="切换主题"
      title="切换主题"
      variant="circle"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground [&_svg]:size-4"
    />
  );
}
