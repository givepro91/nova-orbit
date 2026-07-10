import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("auth");

export function loadOrCreateApiKey(dataDir: string): string {
  const keyPath = join(dataDir, "api-key");
  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, "utf-8").trim();
    if (key) {
      log.info("API key loaded from file");
      return key;
    }
    log.warn("API key file is empty — regenerating");
  }
  const key = randomBytes(32).toString("hex");
  writeFileSync(keyPath, key, { mode: 0o600 });
  log.info("New API key generated and saved");
  return key;
}

export function authMiddleware(apiKey: string, _dataDir: string): RequestHandler {
  return (req, res, next) => {
    // 정적 파일, health check 제외
    if (!req.path.startsWith("/api/") || req.path === "/api/health") {
      return next();
    }

    // 대시보드 초기 키 전달 엔드포인트 — loopback(127.0.0.1)에서만 발급.
    // Tailscale serve 프록시가 loopback 으로 재접속하므로 tailnet 기기 전부 통과한다.
    // one-shot(.key-issued) 잠금 제거 — 개인 도구 + tailnet 격리 전제로 다중 기기 지원.
    if (req.path === "/api/auth/key" && req.query.init === "true") {
      const ip = req.ip || req.socket.remoteAddress;
      if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
        return res.json({ key: apiKey });
      }
      return res.status(403).json({ error: "Forbidden" });
    }

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== apiKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
