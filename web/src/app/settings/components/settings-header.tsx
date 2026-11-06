"use client";

export function SettingsHeader() {
  return (
    <section className="flex items-center justify-between pb-1">
      <div className="flex items-center gap-2">
        <h1 className="font-mono text-base font-bold tracking-tight text-white">系统配置</h1>
        <span className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
          SETTINGS
        </span>
      </div>
    </section>
  );
}
