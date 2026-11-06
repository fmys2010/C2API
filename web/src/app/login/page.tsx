"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, Terminal, Lock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HeaderActions } from "@/components/header-actions";
import { login } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const [authKey, setAuthKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const handleLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      toast.error("请输入系统密钥");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login(normalizedAuthKey);
      await setStoredAuthSession({
        key: normalizedAuthKey,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "密钥鉴权失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="relative grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
      <HeaderActions className="fixed top-4 right-4 z-10" />

      {/* Antigravity Ambient Glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden">
        <div className="h-[380px] w-[380px] rounded-full bg-emerald-500/10 blur-[120px]" />
        <div className="h-[280px] w-[280px] rounded-full bg-cyan-500/10 blur-[100px]" />
      </div>

      <Card className="relative w-full max-w-[440px] rounded-2xl border border-white/[0.1] bg-[#0c0e17]/85 p-0 shadow-2xl backdrop-blur-2xl">
        <CardContent className="space-y-6 p-6 sm:p-7">
          <div className="space-y-3 text-center">
            <div className="mx-auto inline-flex size-11 items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.04] text-emerald-400 shadow-inner">
              <Terminal className="size-5" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-center gap-1.5 font-mono text-[11px] text-zinc-400 uppercase tracking-widest">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>ChatGPT2API Codex</span>
              </div>
              <h1 className="font-mono text-xl font-bold tracking-tight text-white">系统鉴权</h1>
              <p className="font-mono text-xs text-zinc-500">输入管理员或用户密钥以接入管理面板</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between text-zinc-400">
              <label htmlFor="auth-key">API_KEY / ADMIN_KEY</label>
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
              <Input
                id="auth-key"
                type="password"
                value={authKey}
                onChange={(event) => setAuthKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleLogin();
                  }
                }}
                placeholder="请输入密钥..."
                className="h-9.5 rounded-lg border-white/[0.1] bg-[#050609] pl-9 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-emerald-500/50"
              />
            </div>
          </div>

          <Button
            className="h-9.5 w-full rounded-lg bg-emerald-600 font-mono text-xs font-semibold text-white transition hover:bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.25)]"
            onClick={() => void handleLogin()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : null}
            接入终端 (Enter)
          </Button>

          <div className="pt-1 text-center font-mono text-[10px] text-zinc-600">
            SECURE ACCESS · PROT: OPENAI-STD / IMG
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
