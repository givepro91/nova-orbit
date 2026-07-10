import type {
  PreflightCheck,
  PreflightCheckExecution,
  PreflightCheckResult,
} from "./types.js";

export class PreflightError extends Error {
  readonly exitCode = 1 as const;

  /** 첫 필수 실패 (하위호환 — 단일 원인 소비자용). */
  readonly failedCheck: PreflightCheck;
  readonly result: PreflightCheckResult;

  constructor(
    /** 이번 실행에서 실패한 모든 필수 검사 — 복수 원인 일괄 안내용. */
    readonly failures: PreflightCheckExecution[],
    readonly completedChecks: PreflightCheckExecution[],
  ) {
    super(
      `Required preflight check failed: ${failures
        .map(({ check }) => check.id)
        .join(", ")}`,
    );
    this.name = "PreflightError";
    this.failedCheck = failures[0].check;
    this.result = failures[0].result;
  }
}

function failureFromError(error: unknown): PreflightCheckResult {
  return {
    status: "fail",
    summary: "Preflight check could not be completed.",
    detail: error instanceof Error ? error.message : String(error),
    recoveryCommands: [],
  };
}

/**
 * Runs checks one at a time in declaration order.
 *
 * 필수 검사가 실패해도 기본적으로 나머지 검사를 계속 실행해 여러 원인을 한 번에
 * 수집·안내한다. 단, haltChain 이 설정된 필수 검사가 실패하면(이후 검사가 그
 * 성공을 전제로 하므로) 즉시 중단한다. 하나라도 필수 실패가 있으면 모든 실패를
 * 담은 PreflightError 로 reject 해, 호출자(CLI)가 초기화를 이어가지 못하게 한다.
 * The error exposes exitCode=1 for a CLI boundary to convert into a non-zero exit.
 */
export async function runPreflight(
  checks: readonly PreflightCheck[],
): Promise<PreflightCheckExecution[]> {
  const completedChecks: PreflightCheckExecution[] = [];
  const failures: PreflightCheckExecution[] = [];

  for (const check of checks) {
    let result: PreflightCheckResult;
    try {
      result = await check.run();
    } catch (error) {
      result = failureFromError(error);
    }

    const execution = { check, result };
    completedChecks.push(execution);

    if (check.required && result.status === "fail") {
      failures.push(execution);
      if (check.haltChain) break;
    }
  }

  if (failures.length > 0) {
    throw new PreflightError(failures, completedChecks);
  }

  return completedChecks;
}
