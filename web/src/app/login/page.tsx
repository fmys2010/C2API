"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";

import { HeaderActions } from "@/components/header-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const [authKey, setAuthKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
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
      toast.error(error instanceof Error ? error.message : "密钥鉴权失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="grid min-h-dvh w-full place-items-center">
        <LoaderCircle className="size-5 animate-spin text-subtle" />
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh w-full place-items-center px-4 py-6">
      <HeaderActions className="fixed top-4 right-4 z-10" />

      <form onSubmit={(event) => void handleLogin(event)} className="w-full max-w-[360px] space-y-6">
        <div className="space-y-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground">
            C2
          </span>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">登录 chatgpt2api</h1>
            <p className="text-sm text-muted-foreground">输入管理员或用户密钥以进入管理面板。</p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="auth-key" className="text-[13px] font-medium text-foreground">
            密钥
          </label>
          <Input
            id="auth-key"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={authKey}
            onChange={(event) => setAuthKey(event.target.value)}
            placeholder="请输入密钥"
            className="h-10"
          />
        </div>

        <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
          {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
          登录
        </Button>
      </form>
    </div>
  );
}
