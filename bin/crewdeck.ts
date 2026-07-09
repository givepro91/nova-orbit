import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";

const DEFAULT_PORT = 7200;

/**
 * 데이터 디렉토리 결정 순서:
 * 1. --data-dir=<path> 플래그
 * 2. CREWDECK_DATA_DIR 환경변수
 * 3. cwd의 기존 .crewdeck (레거시 — DB가 이미 있을 때만)
 * 4. ~/.crewdeck (정식 기본 위치)
 */
function resolveDataDir(args: string[]): string {
  const flag = args.find((a) => a.startsWith("--data-dir="))?.split("=")[1];
  if (flag) return resolve(flag);
  if (process.env.CREWDECK_DATA_DIR) return resolve(process.env.CREWDECK_DATA_DIR);
  const cwdDir = resolve(process.cwd(), ".crewdeck");
  if (existsSync(resolve(cwdDir, "crewdeck.db"))) return cwdDir;
  return resolve(homedir(), ".crewdeck");
}

async function main() {
  const args = process.argv.slice(2);
  const port = parseInt(
    args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? `${DEFAULT_PORT}`,
    10,
  );
  const noOpen = args.includes("--no-open");

  console.log(`
  ╔══════════════════════════════════════════╗
  ║          Crewdeck v0.1.0              ║
  ║   AI Team Orchestration + Quality Gate  ║
  ╚══════════════════════════════════════════╝
  `);

  // Ensure data directory exists
  const dataDir = resolveDataDir(args);
  if (!existsSync(dataDir)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
    console.log(`  Created data directory: ${dataDir}`);
  } else {
    console.log(`  Data directory: ${dataDir}`);
  }

  // Start server
  const { startServer } = await import("../server/index.js");
  await startServer({ port, dataDir });

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
