"use client";

export function SettingsHeader() {
  return (
    <section className="space-y-0.5">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">系统配置</h1>
      <p className="text-[13px] text-muted-foreground">修改后需要保存才会生效；未保存的内容不会被后台刷新覆盖。</p>
    </section>
  );
}
