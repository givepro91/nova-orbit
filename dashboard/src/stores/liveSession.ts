import { create } from "zustand";
import { api } from "../lib/api";
import type { SteeringNote } from "../../../shared/types";

export interface StreamLine {
  id: number;
  kind: string;
  detail: string;
}

/** 세션당 최근 라인만 유지 — 무제한 누적으로 인한 메모리 증가 방지. */
const STREAM_RING_SIZE = 300;

// 클라이언트 배치 도착 순서를 보존하는 React key. Date.now()는 같은 배치 내에서
// 충돌할 수 있어 부적합.
let streamLineSeq = 0;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Request failed";
}

interface LiveSessionStore {
  // 활성 session의 stdout을 스트림 파서 거쳐 받은 라인 — session:stream(agentId 스코프).
  streamByAgentId: Record<string, StreamLine[] | undefined>;
  appendStream: (agentId: string, events: { kind: string; detail: string }[]) => void;

  // 실행 중 goal 조향(steering) 큐 — goal_steering_notes 를 camelCase로 반영.
  notesByGoalId: Record<string, SteeringNote[] | undefined>;
  loadingByGoalId: Record<string, boolean | undefined>;
  submittingByGoalId: Record<string, boolean | undefined>;
  errorByGoalId: Record<string, string | undefined>;
  fetchNotes: (goalId: string) => Promise<SteeringNote[]>;
  submitNote: (goalId: string, content: string) => Promise<SteeringNote>;
  applySubmitted: (goalId: string, note: SteeringNote) => void;
  applyInjected: (goalId: string, noteIds: string[], injectedStep: string, injectedAt: string) => void;
}

export const useLiveSessionStore = create<LiveSessionStore>((set, get) => ({
  streamByAgentId: {},
  appendStream: (agentId, events) =>
    set((state) => {
      const prev = state.streamByAgentId[agentId] ?? [];
      const appended = events.map((e) => ({ id: ++streamLineSeq, kind: e.kind, detail: e.detail }));
      return {
        streamByAgentId: {
          ...state.streamByAgentId,
          [agentId]: [...prev, ...appended].slice(-STREAM_RING_SIZE),
        },
      };
    }),

  notesByGoalId: {},
  loadingByGoalId: {},
  submittingByGoalId: {},
  errorByGoalId: {},

  fetchNotes: async (goalId) => {
    set((state) => ({
      loadingByGoalId: { ...state.loadingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const notes = await api.goals.listSteering(goalId);
      set((state) => ({ notesByGoalId: { ...state.notesByGoalId, [goalId]: notes } }));
      return notes;
    } catch (error) {
      set((state) => ({ errorByGoalId: { ...state.errorByGoalId, [goalId]: getErrorMessage(error) } }));
      throw error;
    } finally {
      set((state) => ({ loadingByGoalId: { ...state.loadingByGoalId, [goalId]: false } }));
    }
  },

  submitNote: async (goalId, content) => {
    set((state) => ({
      submittingByGoalId: { ...state.submittingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const note = await api.goals.submitSteering(goalId, content);
      get().applySubmitted(goalId, note);
      return note;
    } catch (error) {
      set((state) => ({ errorByGoalId: { ...state.errorByGoalId, [goalId]: getErrorMessage(error) } }));
      throw error;
    } finally {
      set((state) => ({ submittingByGoalId: { ...state.submittingByGoalId, [goalId]: false } }));
    }
  },

  applySubmitted: (goalId, note) =>
    set((state) => {
      const existing = state.notesByGoalId[goalId] ?? [];
      if (existing.some((n) => n.id === note.id)) return {};
      return { notesByGoalId: { ...state.notesByGoalId, [goalId]: [...existing, note] } };
    }),

  applyInjected: (goalId, noteIds, injectedStep, injectedAt) =>
    set((state) => {
      const existing = state.notesByGoalId[goalId];
      if (!existing) return {};
      const idSet = new Set(noteIds);
      return {
        notesByGoalId: {
          ...state.notesByGoalId,
          [goalId]: existing.map((n) => (
            idSet.has(n.id) ? { ...n, injected: true, injectedStep, injectedAt } : n
          )),
        },
      };
    }),
}));
