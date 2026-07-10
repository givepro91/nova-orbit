import {
  dataDirectoryCheck,
  type DataDirectorySelection,
} from "./filesystem-checks.js";
import { portAvailabilityCheck } from "./port-check.js";
import { runtimeChecks, type RuntimeChecksOptions } from "./runtime-checks.js";
import { PreflightError, runPreflight } from "./runner.js";
import type { PreflightCheck, PreflightCheckExecution } from "./types.js";

export { PreflightError, runPreflight } from "./runner.js";
export {
  dataDirectoryCheck,
  resolveDataDirectory,
} from "./filesystem-checks.js";
export type {
  DataDirectorySelection,
  DataDirectorySource,
} from "./filesystem-checks.js";
export { pidLockCheck, portAvailabilityCheck } from "./port-check.js";
export { runtimeChecks } from "./runtime-checks.js";
export type { RuntimeChecksOptions } from "./runtime-checks.js";
export type { EffectiveProviderDecision } from "./provider-check.js";
export type {
  PreflightCheck,
  PreflightCheckExecution,
  PreflightCheckResult,
  PreflightStatus,
} from "./types.js";

interface StartupCheckOptions extends RuntimeChecksOptions {
  dataDirectory: DataDirectorySelection;
  port: number;
  host?: string;
  /** 사용자가 --no-open으로 실행했는지 — provider-cli 복구 재실행 명령이 그대로 재현한다. */
  noOpen?: boolean;
}

/** 런타임 검사 사이에 초기화 전 환경 검사를 배치한다. */
export function startupChecks({
  dataDirectory,
  port,
  host,
  noOpen,
  onProviderResolved,
}: StartupCheckOptions): PreflightCheck[] {
  const checks = runtimeChecks({
    onProviderResolved,
    restart: { dataDir: dataDirectory.path, port, noOpen },
  });
  const claudeCli = checks.pop();
  const environmentChecks = [
    dataDirectoryCheck(dataDirectory),
    portAvailabilityCheck(port, { host, dataDir: dataDirectory.path }),
  ];

  return claudeCli
    ? [...checks, ...environmentChecks, claudeCli]
    : [...checks, ...environmentChecks];
}

/** 모든 check 를 PASS/WARN/FAIL 항목별로 한 줄씩 요약 출력한다. */
function printExecution({ check, result }: PreflightCheckExecution): void {
  const icon =
    result.status === "pass" ? "✓" : result.status === "warning" ? "!" : "✖";
  const line = `  ${icon} [${check.id}] ${result.summary}`;
  if (result.status === "fail") console.error(line);
  else console.log(line);
}

/** 실패한 필수 항목을 모두 모아 원인·복구 명령을 한 번에 안내한다. */
function printFailure(error: PreflightError): void {
  const { failures } = error;
  console.error(
    failures.length > 1
      ? `\n  진단: 필수 항목 ${failures.length}개가 실패했습니다. 아래를 모두 해결한 뒤 다시 실행하세요.`
      : "\n  진단: 필수 항목이 실패했습니다.",
  );
  for (const { check, result } of failures) {
    console.error(`  [${check.id}] ${result.summary}`);
    if (result.detail) console.error(`    상세: ${result.detail}`);
    if (result.recoveryCommands.length > 0) {
      console.error("    복구:");
      for (const command of result.recoveryCommands) {
        console.error(`      $ ${command}`);
      }
    }
  }
  console.error("");
}

/**
 * 시작 프리플라이트를 실행하고 결과를 출력한다.
 *
 * 필수 check 실패 시 진단·복구 안내를 출력한 뒤 PreflightError 를 던져
 * 호출자(CLI)가 후속 초기화를 중단하고 non-zero 로 종료할 수 있게 한다.
 */
export async function runStartupPreflight(
  checks: readonly PreflightCheck[] = runtimeChecks(),
): Promise<PreflightCheckExecution[]> {
  try {
    const executions = await runPreflight(checks);
    for (const execution of executions) printExecution(execution);
    return executions;
  } catch (error) {
    if (error instanceof PreflightError) {
      for (const execution of error.completedChecks) printExecution(execution);
      printFailure(error);
    }
    throw error;
  }
}
