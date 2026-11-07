"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Pencil, SquarePen, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { getImageConversationStats, type ImageConversation } from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[];
  isLoadingHistory: boolean;
  selectedConversationId: string | null;
  onCreateDraft: () => void;
  onClearHistory: () => void | Promise<void>;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  onRenameConversation: (id: string, title: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_LABELS = ["今天", "昨天", "近 7 天", "更早"];

function getGroupIndex(updatedAt: string, startOfToday: number) {
  const time = new Date(updatedAt).getTime();
  if (Number.isNaN(time)) return 3;
  if (time >= startOfToday) return 0;
  if (time >= startOfToday - DAY_MS) return 1;
  if (time >= startOfToday - 7 * DAY_MS) return 2;
  return 3;
}

function groupConversations(conversations: ImageConversation[]) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: ImageConversation[][] = GROUP_LABELS.map(() => []);
  conversations.forEach((conversation) => {
    groups[getGroupIndex(conversation.updatedAt, startOfToday)].push(conversation);
  });
  return GROUP_LABELS.map((label, index) => ({ label, items: groups[index] })).filter((group) => group.items.length > 0);
}

export function ImageSidebar({
  conversations,
  isLoadingHistory,
  selectedConversationId,
  onCreateDraft,
  onClearHistory,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  formatConversationTime,
}: ImageSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startRename = useCallback((conversation: ImageConversation) => {
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
  }, []);

  const commitRename = useCallback(() => {
    const trimmed = editingTitle.trim();
    if (editingId && trimmed) {
      void onRenameConversation(editingId, trimmed);
    }
    setEditingId(null);
    setEditingTitle("");
  }, [editingId, editingTitle, onRenameConversation]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditingTitle("");
  }, []);

  return (
    <aside className="flex h-full min-h-0 flex-col gap-3">
      <button
        type="button"
        onClick={onCreateDraft}
        className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-foreground transition hover:bg-foreground/[0.05]"
      >
        <SquarePen className="size-4" />
        新建对话
      </button>

      <div className="hide-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {isLoadingHistory ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取会话记录
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-2.5 py-2 text-[13px] leading-6 text-subtle">还没有图片记录，发送提示词后会显示在这里。</div>
        ) : (
          groupConversations(conversations).map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <span className="px-2.5 pb-1 text-[11px] font-medium text-subtle">{group.label}</span>
              {group.items.map((conversation) => {
                const active = conversation.id === selectedConversationId;
                const stats = getImageConversationStats(conversation);
                const isBusy = stats.running > 0 || stats.queued > 0;

                if (editingId === conversation.id) {
                  return (
                    <input
                      key={conversation.id}
                      ref={editInputRef}
                      value={editingTitle}
                      aria-label="会话名称"
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") cancelRename();
                      }}
                      className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-[13px] text-foreground outline-none focus:border-ring"
                    />
                  );
                }

                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group relative rounded-lg transition-colors",
                      active ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectConversation(conversation.id)}
                      title={`${conversation.turns.length} 轮 · ${formatConversationTime(conversation.updatedAt)}`}
                      aria-current={active ? "true" : undefined}
                      className={cn(
                        "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 pr-16 text-left text-[13px] sm:pr-2.5 sm:group-focus-within:pr-16 sm:group-hover:pr-16",
                        active ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                      {isBusy ? (
                        <span
                          className="flex shrink-0 items-center gap-1 text-[11px] text-subtle sm:group-focus-within:hidden sm:group-hover:hidden"
                          title={`处理中 ${stats.running}，排队 ${stats.queued}`}
                        >
                          <LoaderCircle className="size-3 animate-spin" />
                          {stats.running + stats.queued}
                        </span>
                      ) : null}
                    </button>
                    <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center transition sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => startRename(conversation)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-subtle transition hover:bg-foreground/[0.07] hover:text-foreground"
                        aria-label="重命名会话"
                        title="重命名"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDeleteConversation(conversation.id)}
                        className="inline-flex size-7 items-center justify-center rounded-md text-subtle transition hover:bg-rose-500/10 hover:text-rose-500"
                        aria-label="删除会话"
                        title="删除"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <button
        type="button"
        onClick={() => void onClearHistory()}
        disabled={conversations.length === 0}
        className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-500 disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash2 className="size-4" />
        清空历史记录
      </button>
    </aside>
  );
}
