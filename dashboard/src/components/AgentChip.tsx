import { AgentAvatar } from "./AgentAvatar";

interface AgentChipProps {
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
  };
  onClick?: () => void;
}

const STATUS_DOT: Record<string, string> = {
  working: "bg-success animate-pulse",
  paused: "bg-warning",
  idle: "bg-fg/30",
};

export function AgentChip({ agent, onClick }: AgentChipProps) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors text-left ${
        agent.status === "working"
          ? "border-success bg-success-subtle"
          : "border-line bg-surface hover:border-line"
      }`}
    >
      <AgentAvatar name={agent.name} role={agent.role} size="xs" />
      <span className="text-[11px] font-medium text-muted truncate max-w-[80px]">
        {agent.name}
      </span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[agent.status] ?? STATUS_DOT.idle}`} />
    </button>
  );
}
