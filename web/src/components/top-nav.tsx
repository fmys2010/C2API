"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, Terminal, Shield, LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { HeaderActions } from "@/components/header-actions";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const adminNavItems = [
  { href: "/accounts", label: "号池管理" },
  { href: "/register", label: "注册机" },
  { href: "/image-manager", label: "图片管理" },
  { href: "/logs", label: "系统终端" },
  { href: "/settings", label: "系统配置" },
];

const userNavItems = [
  { href: "/accounts", label: "号池管理" },
  { href: "/image-manager", label: "图片管理" },
];

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    await clearStoredAuthSession();
    router.replace("/login");
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "ADMIN" : "USER";
  const displayName = session.name.trim() || roleLabel;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/[0.08] bg-[#08090d]/85 backdrop-blur-xl">
      <div className="mx-auto flex h-11 max-w-[1680px] items-center justify-between px-3 sm:px-5">
        {/* Left: Mobile trigger & Brand */}
        <div className="flex items-center gap-3">
          <Sheet>
            <SheetTrigger className="inline-flex size-7 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition hover:bg-white/[0.08] hover:text-white sm:hidden">
              <Menu className="size-3.5" />
              <span className="sr-only">打开导航</span>
            </SheetTrigger>
            <SheetContent side="left" className="border-r border-white/[0.08] bg-[#0c0e17] text-zinc-200">
              <SheetHeader>
                <SheetTitle className="font-mono text-sm font-bold text-white flex items-center gap-2">
                  <span className="size-2 rounded-full bg-emerald-400"></span>
                  chatgpt2api
                </SheetTitle>
                <span className="text-[11px] font-mono text-zinc-500">{roleLabel} · {displayName}</span>
              </SheetHeader>
              <nav className="mt-6 flex flex-col gap-1">
                {navItems.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <SheetClose asChild key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          "flex items-center rounded-lg px-3 py-2 text-xs font-mono transition",
                          active
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                        )}
                      >
                        {item.label}
                      </Link>
                    </SheetClose>
                  );
                })}
              </nav>
              <SheetFooter className="mt-auto pt-4">
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-left text-xs font-mono text-zinc-400 transition hover:bg-rose-500/10 hover:text-rose-400"
                  onClick={() => void handleLogout()}
                >
                  <LogOut className="size-3.5" />
                  退出登录
                </button>
              </SheetFooter>
            </SheetContent>
          </Sheet>

          <Link href="/accounts" className="group flex items-center gap-2">
            <div className="relative flex size-2 items-center justify-center">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]"></span>
            </div>
            <span className="font-mono text-sm font-semibold tracking-tight text-zinc-100 transition-colors group-hover:text-emerald-400">
              chatgpt2api
            </span>
            <span className="hidden rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-mono tracking-widest text-zinc-400 sm:inline-block">
              CODEX
            </span>
          </Link>
        </div>

        {/* Center: Desktop Navigation Tabs */}
        <nav className="hidden items-center gap-1 sm:flex">
          {navItems.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative rounded-md px-3 py-1 text-xs font-mono transition-all",
                  active
                    ? "border border-white/[0.12] bg-white/[0.08] font-medium text-white shadow-xs"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                )}
              >
                {item.label}
                {active ? (
                  <span className="absolute inset-x-2 -bottom-2 h-[2px] rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                ) : null}
              </Link>
            );
          })}
        </nav>

        {/* Right: Actions, Status & Logout */}
        <div className="flex items-center gap-2 sm:gap-2.5">
          {/* Antigravity Online Status indicator */}
          <div className="hidden lg:flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-950/40 px-2.5 py-0.5 text-[10px] font-mono text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>SYSTEM ACTIVE</span>
          </div>

          <span className="hidden rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-zinc-400 md:inline-block">
            {roleLabel} · {displayName}
          </span>

          <HeaderActions />

          <button
            type="button"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-mono text-zinc-500 transition hover:text-rose-400"
            onClick={() => void handleLogout()}
            title="退出登录"
          >
            <LogOut className="size-3" />
            <span className="hidden sm:inline">退出</span>
          </button>
        </div>
      </div>
    </header>
  );
}
