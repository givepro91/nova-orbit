---
paths:
  - "dashboard/**"
---
# Dashboard UI Rules

## 다이얼로그 / 알림 강제

`window.confirm`, `window.alert`, `window.prompt` **사용 금지**. 항상 프로젝트 컴포넌트 사용:

| 용도 | 컴포넌트 | 경로 |
|------|----------|------|
| 확인 다이얼로그 | `ConfirmDialog` | `dashboard/src/components/ConfirmDialog.tsx` |
| 텍스트 입력 | `InputDialog` | `dashboard/src/components/InputDialog.tsx` |
| 알림 | `Toast` | `dashboard/src/components/Toast.tsx` |

> ⚠️ 현재 ESLint 룰로 강제되지 않는다. `no-restricted-globals` 도입 전까지 리뷰어 책임이며, 위반 시 즉시 교체할 것.

## UI 변경 시 사이드이펙트 체크 (필수)

UI 버튼/상태 변경 시:

1. 같은 영역의 모든 인터랙션 요소 (버튼·드롭다운·입력 등) 스캔
2. "이 변경이 영향을 주는 다른 요소: [목록]" 형태로 사용자에게 보고
3. 승인 후 구현

## 비개발자 친화 용어

UI 문자열에서 개발 전문 용어를 직접 노출하지 않는다. 매핑표는 `.claude/rules/ux-terminology.md` 참고.
