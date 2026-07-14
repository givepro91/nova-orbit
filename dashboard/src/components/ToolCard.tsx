import { useState } from "react";

export interface ToolCardData {
  id: string;
  name: string;
  input: unknown;
  state: "running" | "done" | "error";
  result?: string;
}

function summarize(_name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const target = i.file_path ?? i.path ?? i.command ?? i.pattern ?? "";
  return String(target);
}

export function ToolCard({ data }: { data: ToolCardData }) {
  const [open, setOpen] = useState(false);
  const statusChip = {
    running: "text-warning bg-warning-subtle",
    done: "text-success bg-success-subtle",
    error: "text-danger bg-danger-subtle",
  }[data.state];
  const statusLabel = { running: "running", done: "done", error: "error" }[data.state];

  return (
    <div className="border border-line-soft rounded-lg bg-surface overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs hover:bg-fg/5"
      >
        <span className="font-mono font-bold">{data.name}</span>
        <span className="font-mono text-faint truncate flex-1 min-w-0">
          {summarize(data.name, data.input)}
        </span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${statusChip}`}>
          {statusLabel}
        </span>
        <span className="text-faint text-[10px]">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <pre className="border-t border-line-soft px-3 py-2 text-[11px] font-mono text-muted whitespace-pre-wrap break-words bg-sunken m-0">
{data.result ?? JSON.stringify(data.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
