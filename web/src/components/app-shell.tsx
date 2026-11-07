"use client";

import Link from "next/link";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Bot,
  ChevronsUpDown,
  Images,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Toaster } from "sonner";

import { ThemeToggle } from "@/components/theme-toggle";
import { VersionReleaseDialog } from "@/components/version-release-dialog";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

type NavItem = { href: string; label: string; icon: ComponentType<{ className?: string }> };
type NavGroup = { title: string; items: NavItem[] };

const adminNav: NavGroup[] = [
  {
    title: "工作台",
    items: [
      { href: "/image", label: "图片生成", icon: Sparkles },
      { href: "/image-manager", label: "图片管理", icon: Images },
    ],
  },
  {
    title: "号池",
    items: [
      { href: "/accounts", label: "号池管理", icon: Users },
      { href: "/register", label: "注册机", icon: Bot },
    ],
  },
  {
    title: "系统",
    items: [
      { href: "/logs", label: "系统日志", icon: ScrollText },
      { href: "/settings", label: "系统配置", icon: Settings },
    ],
  },
];

const userNav: NavGroup[] = [
  {
    title: "工作台",
    items: [{ href: "/image", label: "图片生成", icon: Sparkles }],
  },
];

/** The static export uses `trailingSlash: true`, so deployed paths look like `/accounts/`. */
function normalizePath(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function BrandMark() {
  return (
    <img src="/brand-icon.png" alt="" className="size-7 shrink-0 rounded-full" />
  );
}

function NavLinks({ groups, pathname, wrap }: { groups: NavGroup[]; pathname: string; wrap?: (node: ReactNode, key: string) => ReactNode }) {
  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-0.5">
          <span className="px-2.5 pb-1 text-[11px] font-medium text-subtle">{group.title}</span>
          {group.items.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            const link = (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                  active
                    ? "bg-foreground/[0.07] font-medium text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-subtle")} />
                {item.label}
              </Link>
            );
            return wrap ? wrap(link, item.href) : link;
          })}
        </div>
      ))}
    </nav>
  );
}

function SessionFooter({ session, onLogout }: { session: StoredAuthSession; onLogout: () => void }) {
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center gap-1">
        <ThemeToggle />
        <a
          href="https://github.com/basketikun/chatgpt2api"
          target="_blank"
          rel="noreferrer"
          aria-label="GitHub 仓库"
          title="GitHub 仓库"
          className="inline-flex size-8 items-center justify-center rounded-lg transition hover:bg-foreground/[0.05]"
        >
          <img src="/github.svg" alt="" className="size-4 dark:invert" />
        </a>
        <VersionReleaseDialog className="ml-auto" />
      </div>
      <div className="flex items-center gap-2 rounded-lg px-1 py-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">{session.name.trim() || roleLabel}</div>
          <div className="text-[11px] text-subtle">{roleLabel}</div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          title="退出登录"
          aria-label="退出登录"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-subtle transition hover:bg-rose-500/10 hover:text-rose-500"
        >
          <LogOut className="size-4" />
        </button>
      </div>
    </div>
  );
}

function AppNavigation({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null>(null);

  useEffect(() => {
    let active = true;
    if (pathname === "/login") {
      setSession(null);
      return;
    }
    void getValidatedAuthSession().then((stored) => {
      if (active) setSession(stored);
    });
    return () => {
      active = false;
    };
  }, [pathname]);

  if (pathname === "/login" || !session) {
    return null;
  }

  const groups = session.role === "admin" ? adminNav : userNav;
  const handleLogout = () => {
    void clearStoredAuthSession().then(() => router.replace("/login"));
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col justify-between border-r border-border bg-sidebar px-3 py-4 lg:flex">
        <div className="flex min-h-0 flex-col gap-6">
          <Link href={session.role === "admin" ? "/accounts" : "/image"} className="flex items-center gap-2.5 px-1">
            <BrandMark />
            <span className="text-sm font-semibold tracking-tight text-foreground">C2API</span>
          </Link>
          <div className="hide-scrollbar min-h-0 overflow-y-auto">
            <NavLinks groups={groups} pathname={pathname} />
          </div>
        </div>
        <SessionFooter session={session} onLogout={handleLogout} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex h-[var(--mobile-bar)] items-center gap-2.5 border-b border-border bg-sidebar px-3 lg:hidden">
        <Sheet>
          <SheetTrigger className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-foreground/[0.05]">
            <Menu className="size-4.5" />
            <span className="sr-only">打开导航</span>
          </SheetTrigger>
          <SheetContent side="left" className="flex w-64 flex-col gap-5 border-r border-border bg-sidebar p-4">
            <SheetHeader className="p-0">
              <SheetTitle className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
                <BrandMark />
                C2API
              </SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NavLinks
                groups={groups}
                pathname={pathname}
                wrap={(node, key) => (
                  <SheetClose asChild key={key}>
                    {node}
                  </SheetClose>
                )}
              />
            </div>
            <SessionFooter session={session} onLogout={handleLogout} />
          </SheetContent>
        </Sheet>
        <BrandMark />
        <span className="text-sm font-semibold tracking-tight text-foreground">C2API</span>
      </header>
    </>
  );
}

function ThemedToaster() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setTheme(root.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return <Toaster position="top-center" richColors theme={theme} />;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = normalizePath(usePathname());
  const isLogin = pathname === "/login";

  return (
    <>
      <ThemedToaster />
      <div className="flex min-h-dvh flex-col lg:flex-row">
        <AppNavigation pathname={pathname} />
        {/* The registration page has a fixed dark palette, so it keeps dark tokens in both themes. */}
        <main className={cn("min-w-0 flex-1", !isLogin && "px-3 py-4 sm:px-5 lg:px-8 lg:py-6", pathname === "/register" && "dark")}>
          <div className="mx-auto max-w-[1600px] space-y-4">{children}</div>
        </main>
      </div>
    </>
  );
}
