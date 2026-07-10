import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightCheck, PreflightCheckResult } from "./types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7200;
const MAX_PORT = 65_535;
const ALTERNATIVE_SCAN_LIMIT = 50;

export type PortProbe = (port: number, host: string) => Promise<void>;

export interface RunningInstance {
  pid: number;
}

/** 데이터 디렉토리를 점유 중인 살아있는 Crewdeck 인스턴스를 탐지한다 (없으면 null). */
export type RunningInstanceProbe = (dataDir: string) => RunningInstance | null;

interface PortCheckOptions {
  host?: string;
  probe?: PortProbe;
  alternativeScanLimit?: number;
  /** 현재 선택된 데이터 디렉토리 — 복구 명령이 이 선택을 잃지 않도록 함께 실어 보낸다. */
  dataDir?: string;
  /** 살아있는 인스턴스 탐지기 (테스트 주입용). 기본은 server.pid liveness 확인. */
  runningInstance?: RunningInstanceProbe;
}

/**
 * 데이터 디렉토리의 server.pid 를 읽어 같은 디렉토리를 이미 점유한 살아있는
 * Crewdeck 인스턴스가 있는지 확인한다. server/index.ts 의 PID lock 은
 * data directory 단위라, 살아있는 인스턴스가 있으면 포트만 바꿔 재실행해도
 * 그 lock 에서 다시 막힌다 — 포트 충돌 복구 안내가 실제로 복구되려면 이 사실을
 * 반영해야 한다.
 */
function detectRunningInstance(dataDir: string): RunningInstance | null {
  const pidPath = join(dataDir, "server.pid");
  if (!existsSync(pidPath)) return null;
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try {
      process.kill(pid, 0); // signal 0 = 프로세스를 건드리지 않는 liveness probe
      return { pid };
    } catch {
      return null; // stale pid — 죽은 인스턴스
    }
  } catch {
    return null; // 읽을 수 없는 pid 파일
  }
}

function probePort(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.once("listening", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    server.listen({ port, host, exclusive: true });
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return String(error.code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 재시작 복구 명령을 만든다 — 현재 데이터 디렉토리 선택을 잃지 않도록 --data-dir을 함께 싣는다. */
function recoveryCommand(port: number, dataDir?: string): string {
  const dataDirFlag = dataDir ? `--data-dir=${shellQuote(dataDir)} ` : "";
  return `npx crewdeck ${dataDirFlag}--port=${port}`;
}

function nextCandidate(port: number): number {
  return port >= MAX_PORT ? 1_024 : port + 1;
}

async function findAlternativePort(
  requestedPort: number,
  host: string,
  probe: PortProbe,
  scanLimit: number,
): Promise<number | null> {
  let candidate = nextCandidate(requestedPort);

  for (let attempt = 0; attempt < scanLimit; attempt += 1) {
    if (candidate === requestedPort) return null;
    try {
      await probe(candidate, host);
      return candidate;
    } catch {
      candidate = nextCandidate(candidate);
    }
  }

  return null;
}

interface PidLockCheckOptions {
  /** 살아있는 인스턴스 탐지기 (테스트 주입용). 기본은 server.pid liveness 확인. */
  runningInstance?: RunningInstanceProbe;
}

/**
 * 데이터 디렉토리를 점유 중인 살아있는 인스턴스를 preflight 항목으로 진단한다.
 *
 * PID lock 은 data directory 단위라, 요청 포트가 비어 있어도 살아있는 인스턴스가
 * 있으면 server/index.ts 의 lock 에서 시작이 막힌다. 포트만 PASS 하고 조용히
 * 종료하는 대신 [pid-lock] FAIL 로 원인·복구를 항목별로 노출한다.
 *
 * server.pid 의 PID 는 재사용되어 무관한 프로세스를 가리킬 수 있으므로, 소유권을
 * '다른 서버 인스턴스'라고 단정하거나 kill/rm 을 안내하지 않는다. 살아 있는
 * PID가 확인된 상태에서 lock 삭제를 자동 안내하면 실제 Crewdeck 인스턴스의
 * 동시 실행 방지 계약을 우회할 수 있다.
 */
export function pidLockCheck(
  dataDir: string,
  options: PidLockCheckOptions = {},
): PreflightCheck {
  const runningInstance = options.runningInstance ?? detectRunningInstance;

  return {
    id: "pid-lock",
    required: true,
    run: (): PreflightCheckResult => {
      const running = runningInstance(dataDir);
      if (!running) {
        return {
          status: "pass",
          summary: "데이터 디렉토리를 점유한 다른 인스턴스가 없습니다.",
          detail:
            "server.pid 가 없거나 죽은 프로세스를 가리킵니다 — 이 데이터 디렉토리로 시작할 수 있습니다.",
          recoveryCommands: [],
        };
      }

      return {
        status: "fail",
        summary: `server.pid가 살아 있는 프로세스를 가리키고 있습니다 (pid ${running.pid}).`,
        detail:
          `같은 데이터 디렉토리에서는 PID lock 때문에 다른 포트로 재실행해도 시작할 수 없습니다. ` +
          `아래 조회 명령으로 해당 PID 를 먼저 확인하세요. Crewdeck 이면 실행 중인 대시보드를 사용하거나 그 프로세스를 종료하세요. ` +
          `Crewdeck 이 아니라면(재사용된 PID) server.pid 소유권을 수동으로 확인한 뒤 조치하세요.`,
        recoveryCommands: [`ps -p ${running.pid} -o pid=,command=`],
      };
    },
  };
}

/** 요청 포트를 실제로 bind한 뒤 닫아 서버 시작 가능 여부를 확인한다. */
export function portAvailabilityCheck(
  requestedPort: number,
  options: PortCheckOptions = {},
): PreflightCheck {
  const host = options.host ?? DEFAULT_HOST;
  const probe = options.probe ?? probePort;
  const scanLimit = options.alternativeScanLimit ?? ALTERNATIVE_SCAN_LIMIT;
  const dataDir = options.dataDir;
  const runningInstance = options.runningInstance ?? detectRunningInstance;

  return {
    id: "port",
    required: true,
    run: async (): Promise<PreflightCheckResult> => {
      if (!isValidPort(requestedPort)) {
        return {
          status: "fail",
          summary: `유효하지 않은 포트입니다: ${String(requestedPort)}`,
          detail: "포트는 1부터 65535 사이의 정수여야 합니다.",
          recoveryCommands: [recoveryCommand(DEFAULT_PORT, dataDir)],
        };
      }

      try {
        await probe(requestedPort, host);
        return {
          status: "pass",
          summary: `${host}:${requestedPort} 포트 사용 가능`,
          detail: "요청 포트에 bind할 수 있습니다.",
          recoveryCommands: [],
        };
      } catch (error) {
        if (errorCode(error) !== "EADDRINUSE") {
          return {
            status: "fail",
            summary: `${host}:${requestedPort} 포트에 bind할 수 없습니다.`,
            detail: errorMessage(error),
            recoveryCommands: [],
          };
        }

        // 같은 데이터 디렉토리의 PID lock이 살아있는 프로세스를 가리키면,
        // 포트만 바꾼 재실행은 server/index.ts 의 PID lock 에서 다시 막힌다.
        // 단, PID 재사용으로 무관한 프로세스를 가리킬 수 있으므로 소유권을 확인하지
        // 않은 상태에서 kill 명령을 안내하지 않는다.
        const running = dataDir ? runningInstance(dataDir) : null;
        if (running) {
          return {
            status: "fail",
            summary: `server.pid가 살아 있는 프로세스를 가리키고 있습니다 (pid ${running.pid}).`,
            detail:
              `같은 데이터 디렉토리에서는 PID lock 때문에 다른 포트로 재실행해도 시작할 수 없습니다. ` +
              `안내된 조회 명령으로 해당 PID가 Crewdeck인지 확인한 뒤, 실행 중인 대시보드를 사용하거나 직접 종료하고 다시 실행하세요.`,
            recoveryCommands: [
              `ps -p ${running.pid} -o pid=,command=`,
              recoveryCommand(requestedPort, dataDir),
            ],
          };
        }

        const alternativePort = await findAlternativePort(
          requestedPort,
          host,
          probe,
          scanLimit,
        );
        const recoveryCommands = alternativePort === null
          ? []
          : [recoveryCommand(alternativePort, dataDir)];

        return {
          status: "fail",
          summary: `${host}:${requestedPort} 포트를 이미 다른 프로세스가 사용 중입니다.`,
          detail: alternativePort === null
            ? `대체 포트를 ${scanLimit}개 확인했지만 사용 가능한 포트를 찾지 못했습니다.`
            : `${host}:${alternativePort} 포트는 현재 bind 가능합니다.`,
          recoveryCommands,
        };
      }
    },
  };
}
