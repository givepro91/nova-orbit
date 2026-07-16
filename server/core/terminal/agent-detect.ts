import { execFileSync } from "node:child_process";
import type { AgentProvider } from "../../../shared/types.js";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** `ps -axo pid=,ppid=,command=` 출력 파싱. */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return entries;
}

/**
 * 커맨드라인에서 실행 중인 에이전트 CLI를 식별한다.
 * 직접 실행("claude --flag")과 인터프리터 shim("node /path/bin/claude --flag")을 모두 잡되,
 * crewdeck-mcp 같은 자식 프로세스는 basename 완전 일치가 아니므로 제외된다.
 */
function commandAgent(command: string): AgentProvider | null {
  const tokens = command.trim().split(/\s+/).slice(0, 2);
  for (const token of tokens) {
    const base = token.split("/").pop() ?? "";
    if (base === "claude") return "claude";
    if (base === "codex") return "codex";
  }
  return null;
}

/**
 * rootPid(터미널 셸)의 자손 중 실행 중인 에이전트 CLI를 찾는다.
 * BFS로 가장 얕은 매치를 반환 — 사용자가 상호작용하는 REPL이 셸에 가장 가깝고,
 * 에이전트가 띄운 하위 프로세스(MCP 서버 등)는 더 깊은 층에 있다.
 */
export function findAgentInTree(entries: ProcessEntry[], rootPid: number): AgentProvider | null {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  let level = children.get(rootPid) ?? [];
  while (level.length > 0) {
    for (const entry of level) {
      const agent = commandAgent(entry.command);
      if (agent) return agent;
    }
    level = level.flatMap((entry) => children.get(entry.pid) ?? []);
  }
  return null;
}

export function snapshotProcessTable(): ProcessEntry[] {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseProcessTable(output);
  } catch {
    return [];
  }
}

/** 감지 실패(ps 불가 등)는 null — 호출부는 null을 "에이전트 없음"의 안전한 기본값으로 다룬다. */
export function detectRunningAgent(
  rootPid: number | null | undefined,
  table: ProcessEntry[] = snapshotProcessTable(),
): AgentProvider | null {
  if (!rootPid || !Number.isFinite(rootPid)) return null;
  return findAgentInTree(table, rootPid);
}
