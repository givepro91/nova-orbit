---
paths:
  - "dashboard/**"
---
# UX 용어 매핑 (비개발자 친화)

Crewdeck은 **개발자 + 비개발자(PM, 파운더 등)** 모두를 위한 도구다. UI 문자열 작성 시 개발 전문 용어를 직접 노출하지 않는다.

| 금지 용어 | EN 대체 | KO 대체 |
|-----------|---------|---------|
| Decompose | Split into Tasks | 작업 분할 |
| System Prompt | Role Instructions | 역할 지시사항 |
| Spec | Blueprint | 기획서 |
| Preset | Template | 템플릿 |
| Queue | Auto-run | 자동 실행 |
| Rate Limit | Usage Limit | 사용량 한도 |
| Working Directory | Project Folder | 프로젝트 폴더 |
| Kill Session | End Session | 에이전트 종료 |
| Worktree | Isolated workspace | 독립된 작업 공간 |
| Branch/Merge (사용자 노출) | Save/Apply | 저장/반영 |

## 그 외 규칙

- **Session ID, UUID 등 내부 식별자**는 기본 숨김 또는 "Agent ID"로 표기.
- **Autopilot 모드명**: Manual→수동, Semi-Auto→반자동, Full Auto→완전 자동.
- 새 UI 문자열 추가 시 자문: **"비개발자가 이해할 수 있는가?"**
- 코드/로그/디버그 패널처럼 개발자 전용 영역에서는 원어 유지 가능. 단, 사용자 노출 면(버튼 라벨, 다이얼로그 제목, Toast 메시지 등)에서는 위 매핑 준수.
