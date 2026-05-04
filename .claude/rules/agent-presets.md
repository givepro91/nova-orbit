---
paths:
  - "templates/agents/**"
---
# Agent Preset Structure

`templates/agents/*.yaml` 프리셋은 다음 구조를 따른다:

```yaml
name: Agent Name
role: role_id
description: "한줄 설명"
order: 1                # UI 정렬 순서
systemPrompt: |
  # Role            — 역할 정의
  # Responsibilities — 핵심 책임
  # Constraints     — 하지 말 것
  # Output Format   — 출력 형식 (해당 시)
  # Collaboration   — 다른 에이전트와의 관계
```

현재 9개 프리셋: cto, pm, backend, frontend, ux, qa, reviewer, devops, marketer.

## 추가 / 수정 시 체크

- `order` 충돌 확인 (다른 프리셋과 겹치지 않게).
- `role` ID는 snake_case + 고유.
- `systemPrompt`는 5-section 구조 유지 (Role / Responsibilities / Constraints / Output Format / Collaboration).
- Smart Team Suggestion 우선순위(`.claude/agents/` > `CLAUDE.md` > `package.json`) 영향을 고려.
- 사용자 노출 문자열(`description`, `name`)은 비개발자 친화 용어 사용 — `.claude/rules/ux-terminology.md` 참고.
