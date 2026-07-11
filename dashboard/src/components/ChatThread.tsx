import { useEffect, useRef, useState } from "react";
import type { ChatEvent } from "../types";
import { ToolCard, type ToolCardData } from "./ToolCard";

type Item =
  | { row: "text"; text: string }
  | { row: "thinking"; text: string }
  | { row: "tool"; data: ToolCardData }
  | { row: "todo"; items: Array<{ content: string; status: string }> };

export function ChatThread({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolIndex = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId: aid, event } = (e as CustomEvent<{ agentId: string; event: ChatEvent }>).detail;
      if (aid !== agentId) return;
      setItems((prev) => {
        const next = [...prev];
        switch (event.kind) {
          case "text":
          case "result":
            next.push({ row: "text", text: event.text });
            break;
          case "thinking":
            next.push({ row: "thinking", text: event.text });
            break;
          case "todo":
            next.push({ row: "todo", items: event.items });
            break;
          case "tool_use": {
            toolIndex.current.set(event.id, next.length);
            next.push({ row: "tool", data: { id: event.id, name: event.name, input: event.input, state: "running" } });
            break;
          }
          case "tool_result": {
            const idx = toolIndex.current.get(event.id);
            if (idx != null && next[idx]?.row === "tool") {
              const t = next[idx] as Extract<Item, { row: "tool" }>;
              next[idx] = { row: "tool", data: { ...t.data, state: event.isError ? "error" : "done", result: event.content } };
            }
            break;
          }
        }
        return next;
      });
    };
    window.addEventListener("crewdeck:chat-event", handler);
    return () => window.removeEventListener("crewdeck:chat-event", handler);
  }, [agentId]);

  // 강제 오토스크롤 금지 — 바닥 근처(80px)일 때만 follow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
      {items.map((it, i) => {
        if (it.row === "tool") return <ToolCard key={i} data={it.data} />;
        if (it.row === "thinking")
          return (
            <details key={i} className="text-xs">
              <summary className="text-gray-400 dark:text-gray-500 cursor-pointer">🧠 생각 정리</summary>
              <div className="text-gray-500 dark:text-gray-400 border-l-2 border-gray-200 dark:border-gray-700 pl-2 mt-1 whitespace-pre-wrap">{it.text}</div>
            </details>
          );
        if (it.row === "todo")
          return (
            <div key={i} className="border border-gray-100 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 px-3 py-2 text-xs">
              <div className="font-semibold mb-1">
                진행 {it.items.filter((t) => t.status === "completed").length} / {it.items.length}
              </div>
              {it.items.map((t, j) => (
                <div key={j} className={t.status === "completed" ? "text-gray-400 line-through" : t.status === "in_progress" ? "font-semibold" : "opacity-70"}>
                  {t.status === "completed" ? "✓" : "▸"} {t.content}
                </div>
              ))}
            </div>
          );
        return <div key={i} className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">{it.text}</div>;
      })}
    </div>
  );
}
