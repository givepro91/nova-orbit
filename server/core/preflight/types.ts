export type PreflightStatus = "pass" | "warning" | "fail";

export interface PreflightCheckResult {
  status: PreflightStatus;
  summary: string;
  detail: string;
  recoveryCommands: string[];
}

export interface PreflightCheck {
  id: string;
  required: boolean;
  /**
   * 필수 검사가 실패했을 때 이후 검사까지 중단할지 여부.
   * 기본(false)이면 실패를 수집하고 나머지 검사를 계속 실행해 복수 원인을 한 번에 안내한다.
   * 이후 검사가 이 검사의 성공을 전제로 할 때만 true (예: Node 버전 → 네이티브 모듈 로드).
   */
  haltChain?: boolean;
  run: () => PreflightCheckResult | Promise<PreflightCheckResult>;
}

export interface PreflightCheckExecution {
  check: PreflightCheck;
  result: PreflightCheckResult;
}
