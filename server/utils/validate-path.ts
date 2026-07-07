import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";

export function validateWorkdir(inputPath: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new Error("Path must not be empty");
  }
  const preliminary = resolve(inputPath);
  const real = existsSync(preliminary) ? realpathSync(preliminary) : preliminary;
  const home = homedir();
  // macOS 에서 /tmp 는 /private/tmp 의 symlink — realpath 로 풀린 경로도 허용해야
  // "/tmp 허용" 분기가 dead code 가 되지 않는다
  const tmpReal = (() => {
    try {
      return realpathSync("/tmp");
    } catch {
      return "/tmp";
    }
  })();
  if (!real.startsWith(home) && !real.startsWith("/tmp") && !real.startsWith(tmpReal)) {
    throw new Error("Path must be within home directory or /tmp");
  }
  return real;
}
