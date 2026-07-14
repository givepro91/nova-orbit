import { ROLE_BADGE_ICONS, ROLE_COLORS } from "../lib/constants";

type AvatarSize = "xs" | "sm" | "md" | "lg";

interface AgentAvatarProps {
  name: string;
  role: string;
  size?: AvatarSize;
  showBadge?: boolean;
}

const SIZE_CLASS: Record<AvatarSize, string> = {
  xs: "w-5 h-5 text-[8px]",
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-sm",
  lg: "w-12 h-12 text-lg",
};

const BADGE_SIZE_CLASS: Record<AvatarSize, string> = {
  xs: "w-2.5 h-2.5 text-[5px]",
  sm: "w-3 h-3 text-[6px]",
  md: "w-3.5 h-3.5 text-[7px]",
  lg: "w-5 h-5 text-[10px]",
};

export function AgentAvatar({ name, role, size = "md", showBadge = true }: AgentAvatarProps) {
  const colors = ROLE_COLORS[role] ?? ROLE_COLORS.custom;
  const initial = (name?.[0] ?? "A").toUpperCase();
  const badgeIcon = ROLE_BADGE_ICONS[role] ?? ROLE_BADGE_ICONS.custom;

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={`${SIZE_CLASS[size]} rounded-full bg-gradient-to-br ${colors.from} ${colors.to} flex items-center justify-center font-bold text-white`}
      >
        {initial}
      </div>
      {showBadge && (
        <span
          className={`${BADGE_SIZE_CLASS[size]} absolute -bottom-0.5 -right-0.5 rounded-full bg-surface flex items-center justify-center leading-none`}
        >
          {badgeIcon}
        </span>
      )}
    </div>
  );
}
