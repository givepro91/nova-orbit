import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 대시보드 컴포넌트 테스트 전용 설정 — 프로덕션 빌드(vite.config.ts)와 분리한다.
// react 변환 + jsdom 환경만 두고 tailwind는 뺀다(테스트는 CSS 렌더가 불필요).
// 테스트는 vitest/@testing-library를 명시 import하므로 globals는 켜지 않는다.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
