"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePersistentState } from "@/lib/use-persistent-state";

import { ApiDocsCard } from "./components/api-docs-card";
import { ConfigCard } from "./components/config-card";
import { ProxyRuntimeCard } from "./components/proxy-runtime-card";
import { SettingsHeader } from "./components/settings-header";
import { UserKeysCard } from "./components/user-keys-card";
import { selectIsConfigDirty, useSettingsStore } from "./store";

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

function UnsavedChangesBar() {
  const isDirty = useSettingsStore(selectIsConfigDirty);
  const isSaving = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const discard = useSettingsStore((state) => state.discardConfigChanges);

  // Warn before a reload or tab close would drop edits. In-app navigation keeps them in the store.
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  if (!isDirty) return null;

  return (
    <div
      role="status"
      className="sticky bottom-3 z-30 flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-sm"
    >
      <span className="text-[13px] text-foreground">有未保存的修改</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={discard} disabled={isSaving}>
          放弃
        </Button>
        <Button size="sm" onClick={() => void saveConfig()} disabled={isSaving}>
          {isSaving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          保存
        </Button>
      </div>
    </div>
  );
}

function SettingsPageContent() {
  const [activeTab, setActiveTab] = usePersistentState("settings.tab", "basic");

  return (
    <div className="space-y-4">
      <SettingsDataController />
      <SettingsHeader />
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="overflow-x-auto border-b border-border">
          <TabsList variant="line" className="min-w-max justify-start gap-1 bg-transparent p-0">
            {settingsTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="px-3 py-2 text-[13px] text-muted-foreground data-[state=active]:text-foreground">
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
      <UnsavedChangesBar />
    </div>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-subtle" />
      </div>
    );
  }

  return <SettingsPageContent />;
}
