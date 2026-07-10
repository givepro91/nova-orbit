import { exec } from "node:child_process";

const DEFAULT_PORT = 7200;

function requestedPort(args: readonly string[]): number {
  const argument = args.find((value) => value.startsWith("--port="));
  if (!argument) return DEFAULT_PORT;

  const value = argument.slice("--port=".length);
  return /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

async function main() {
  const args = process.argv.slice(2);
  const port = requestedPort(args);
  const noOpen = args.includes("--no-open");

  console.log(`
  ╔══════════════════════════════════════════╗
  ║          Crewdeck v0.1.0              ║
  ║   AI Team Orchestration + Quality Gate  ║
  ╚══════════════════════════════════════════╝
  `);

  // Preflight — 필수 런타임 진단. 실패 시 복구 안내 후 non-zero 종료 (DB 초기화 이전).
  const {
    resolveDataDirectory,
    runStartupPreflight,
    startupChecks,
    PreflightError,
  } = await import(
    "../server/core/preflight/index.js"
  );
  const { setRuntimeDefaultProvider } = await import(
    "../server/core/agent/provider.js"
  );
  const dataDirectory = resolveDataDirectory(args);
  const dataDir = dataDirectory.path;
  const host = process.env.CREWDECK_HOST ?? "127.0.0.1";
  console.log(`  Data directory: ${dataDir}`);
  console.log(`  Selected because: ${dataDirectory.reason}`);

  try {
    // provider-cli 진단이 확인한 실제 실행 provider(폴백 포함)를 이 프로세스의
    // 전역 기본값으로 적용 — 진단 메시지와 실제 세션 spawn 결과가 어긋나지 않도록.
    await runStartupPreflight(
      startupChecks({
        dataDirectory,
        port,
        host,
        noOpen,
        onProviderResolved: (decision) => setRuntimeDefaultProvider(decision.provider),
      }),
    );
    // Start server only after the CLI-level checks pass. Server-level provider
    // override checks throw the same shaped error from a separately built bundle.
    const serverEntry = "../server/index.js";
    const { startServer } = await import(serverEntry);
    await startServer({ port, dataDir });
  } catch (err) {
    if (
      err instanceof PreflightError ||
      (err instanceof Error && err.name === "PreflightError" && "exitCode" in err)
    ) {
      console.error("  Crewdeck 을 시작할 수 없습니다. 위 복구 명령을 실행한 뒤 다시 시도하세요.");
      process.exit(1);
    }
    throw err;
  }

  const url = `http://localhost:${port}`;
  console.log(`
  Dashboard: ${url}
  Press Ctrl+C to stop.
  `);

  if (!noOpen) {
    if (process.platform === "darwin") exec(`open ${url}`);
    else if (process.platform === "linux") exec(`xdg-open ${url}`);
    else if (process.platform === "win32") exec(`start ${url}`);
  }
}

main().catch((err) => {
  console.error("Failed to start Crewdeck:", err);
  process.exit(1);
});
