/**
 * AI 생성물(목표·팀 설계·mission 제안 등)의 출력 언어 규칙 한 줄을 만든다.
 *
 * language(대시보드 UI 언어, "ko"|"en")가 주어지면 그 언어로 강제한다.
 * 주어지지 않으면 fallback(기존 동작 = 프로젝트 mission/docs 언어 따라가기)을 쓴다 →
 * 언어를 안 넘기는 기존 호출·테스트와 하위호환.
 *
 * 한국어 강제 시에도 코드·식별자·경로·기술 용어는 원문 유지(AGENTS.md 규약).
 */
export function promptLanguageRule(language?: string | null, fallback?: string): string {
  const lang = typeof language === "string" ? language.toLowerCase() : "";
  if (lang.startsWith("ko")) {
    return "Respond entirely in Korean (한국어). Keep code, identifiers, file paths, and technical terms in their original form.";
  }
  if (lang.startsWith("en")) {
    return "Respond entirely in English.";
  }
  return fallback ?? "Respond in the same language as the project mission/docs (Korean if Korean, English if English).";
}
