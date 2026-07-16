import { create } from "zustand";
import type { GoalListItem } from "../lib/api";
import type { ReportSummary, Workspace } from "../../../shared/types";

interface GitHubConfig {
  repoUrl: string;
  branch: string;
  autoPush: boolean;
  prMode: boolean;
  gitMode?: "branch_only" | "pr" | "main_direct" | "local_only";
}

interface Project {
  id: string;
  name: string;
  mission: string;
  source: string;
  status: string;
  workdir: string;
  created_at: string;
  github?: GitHubConfig;
  dev_port?: number;
  base_branch?: string;
  autopilot?: "off" | "goal" | "full";
  /** Execution engine(s) this project's agents resolve to (Claude/Codex). */
  providers?: ("claude" | "codex")[];
}

interface Agent {
  id: string;
  project_id: string;
  name: string;
  role: string;
  status: string;
  current_task_id: string | null;
  current_activity: string | null;
  parent_id?: string | null;
  system_prompt?: string;
  session_id?: string;
  prompt_source?: string;
  resolved_prompt_source?: string;
  resolved_prompt_file?: string;
  needs_worktree?: number;
  model?: string | null;
  provider?: string | null;
}

interface Task {
  id: string;
  goal_id: string;
  project_id: string;
  title: string;
  description: string;
  assignee_id: string | null;
  status: string;
  verification_id: string | null;
  result_summary?: string | null;
  depends_on?: string | null;
  priority?: string;
}

type Goal = GoalListItem;

interface AppStore {
  // Projects
  projects: Project[];
  currentProjectId: string | null;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (id: string | null) => void;
  updateProject: (project: Project) => void;
  removeProject: (id: string) => void;

  // Read-only Workspace projection
  workspaces: Workspace[];
  setWorkspaces: (workspaces: Workspace[]) => void;

  // Agents
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;

  // Goals
  goals: Goal[];
  setGoals: (goals: Goal[]) => void;
  updateGoal: (goal: Partial<Goal> & { id: string }) => void;

  // Goal execution reports
  goalReports: ReportSummary[];
  setGoalReports: (reports: ReportSummary[]) => void;

  // Tasks
  tasks: Task[];
  setTasks: (tasks: Task[]) => void;
  updateTask: (task: Partial<Task> & { taskId?: string }) => void;

  // WebSocket
  connected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useStore = create<AppStore>((set) => ({
  projects: [],
  currentProjectId: null,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => {
    if (id !== null) {
      localStorage.setItem("crewdeck-current-project", id);
    }
    // workspaces는 프로젝트가 실제로 바뀔 때만 비운다. Sidebar의 로드 effect는
    // currentProjectId 변경에만 반응하므로, 같은 프로젝트를 재클릭할 때 비우면
    // 재조회 없이 빈 목록만 남는다.
    set((state) => state.currentProjectId === id
      ? { currentProjectId: id }
      : { currentProjectId: id, workspaces: [] });
  },
  updateProject: (project) =>
    set((state) => ({
      projects: state.projects.map((p) => (p.id === project.id ? project : p)),
    })),
  removeProject: (id) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
      workspaces: state.currentProjectId === id ? [] : state.workspaces,
    })),

  workspaces: [],
  setWorkspaces: (workspaces) => set({ workspaces }),

  agents: [],
  setAgents: (agents) => set({ agents }),

  goals: [],
  setGoals: (goals) => set({ goals }),
  updateGoal: (goal) =>
    set((state) => ({
      goals: state.goals.map((g) => (g.id === goal.id ? { ...g, ...goal } : g)),
    })),

  goalReports: [],
  setGoalReports: (goalReports) => set({ goalReports }),

  tasks: [],
  setTasks: (tasks) => set({ tasks }),
  updateTask: (task) =>
    set((state) => {
      // 서버 broadcast 는 전체 row 와 부분 페이로드({taskId, status})가 섞여 온다.
      // 부분 페이로드는 기존 태스크에 merge 만 하고, append 는 완전한 row 일 때만 —
      // id/title 없는 유령 태스크가 리스트에 들어가면 렌더가 크래시한다.
      const id = task.id ?? task.taskId;
      if (!id) return {};
      const exists = state.tasks.some((t) => t.id === id);
      if (exists) {
        return {
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...task, id } : t)),
        };
      }
      if (!task.id || typeof task.title !== "string") return {};
      return { tasks: [...state.tasks, task as Task] };
    }),

  connected: false,
  setConnected: (connected) => set({ connected }),
}));
