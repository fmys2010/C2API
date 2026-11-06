"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";

import { ApiDocsCard } from "./components/api-docs-card";
import { ConfigCard } from "./components/config-card";
import { ProxyRuntimeCard } from "./components/proxy-runtime-card";
import { SettingsHeader } from "./components/settings-header";
import { UserKeysCard } from "./components/user-keys-card";
import { useSettingsStore } from "./store";

const settingsTabs = [
  { value: "basic", title: "基础配置" },
  { value: "proxy", title: "FlareSolverr" },
  { value: "keys", title: "用户密钥" },
  { value: "api-docs", title: "接口接入" },
];

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  return null;
}

function SettingsPageContent() {
  return (
    <div className="space-y-3">
      <SettingsDataController />
      <SettingsHeader />
      <Tabs defaultValue="basic" className="space-y-3">
        <div className="sticky top-12 z-20 overflow-x-auto rounded-lg border border-white/[0.08] bg-[#0c0e17]/90 p-1 shadow-md backdrop-blur-md">
          <TabsList variant="line" className="min-w-max justify-start gap-1 bg-transparent p-0">
            {settingsTabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded px-3 py-1 font-mono text-xs text-zinc-400 transition-colors data-[state=active]:border data-[state=active]:border-white/[0.12] data-[state=active]:bg-white/[0.08] data-[state=active]:text-white"
              >
                {tab.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="basic">
          <ConfigCard />
        </TabsContent>
        <TabsContent value="proxy">
          <ProxyRuntimeCard />
        </TabsContent>
        <TabsContent value="keys">
          <UserKeysCard />
        </TabsContent>
        <TabsContent value="api-docs">
          <ApiDocsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-zinc-500" />
      </div>
    );
  }

  return <SettingsPageContent />;
}
