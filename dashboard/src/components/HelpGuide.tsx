import type { ReactNode } from "react";

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-baseline gap-2 text-sm font-bold text-fg">
        <span className="font-mono text-xs text-accent">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-accent">{children}</code>;
}

export function HelpGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-bold text-fg">⌘ Crewdeck Terminal Workspace</h2>
            <span className="text-xs text-faint">사용 가이드</span>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-faint hover:bg-fg/5" aria-label="닫기">✕</button>
        </div>

        <div className="space-y-6 overflow-y-auto px-5 py-5 text-sm text-muted">
          <p className="leading-relaxed text-fg">
            Orca처럼 프로젝트 Workspace에서 <b>실제 로컬 shell</b>을 열고 Claude·Codex와 직접 작업합니다.
            Crewdeck은 터미널을 채팅으로 바꾸지 않고, 옆에서 에이전트 조직·목표·태스크·변경·판정을 실시간으로 연결합니다.
          </p>

          <div className="flex items-stretch gap-1.5 text-center">
            {[
              ["Workspace", "격리 worktree"],
              ["Local PTY", "직접 명령"],
              ["AI + MCP", "자동 동기화"],
              ["Crewdeck", "목표·태스크"],
            ].map(([title, detail], index, items) => (
              <div key={title} className="flex flex-1 items-center">
                <div className="flex-1 rounded-lg border border-line bg-sunken px-2 py-2">
                  <div className="text-xs font-bold text-fg">{title}</div>
                  <div className="mt-0.5 text-[10px] text-faint">{detail}</div>
                </div>
                {index < items.length - 1 && <span className="px-0.5 text-accent">→</span>}
              </div>
            ))}
          </div>

          <Section n="1" title="화면 구조">
            <div className="grid grid-cols-3 gap-2">
              {[
                ["왼쪽 탐색", "Workspace, 에이전트 조직, 목표 진행률"],
                ["중앙 터미널", "ANSI·키 입력·리사이즈를 지원하는 로컬 PTY"],
                ["오른쪽 Crewdeck", "목표/태스크, diff, 출력, 파일, 판정"],
              ].map(([title, detail]) => (
                <div key={title} className="rounded-lg border border-line bg-elevated px-3 py-2">
                  <div className="text-xs font-bold text-fg">{title}</div>
                  <div className="mt-1 text-[11px] leading-relaxed text-muted">{detail}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section n="2" title="Claude·Codex 시작">
            <p>상단의 <b className="text-[#c7a8ff]">Claude</b> 또는 <b className="text-[#7cc4ff]">Codex</b> 버튼을 누르거나 터미널에 직접 <Code>claude</Code>·<Code>codex</Code>를 입력하세요.</p>
            <p>Workspace shell이 두 CLI에 Crewdeck MCP를 자동 연결합니다. 기존 사용자 설정과 인증은 그대로 사용합니다.</p>
          </Section>

          <Section n="3" title="목표·태스크 자동 동기화">
            <ul className="space-y-1.5">
              <li>• AI는 작업 시작 전 현재 조직·목표·태스크를 <Code>crewdeck_get_context</Code>로 읽습니다.</li>
              <li>• 새로운 작업이면 <Code>crewdeck_create_goal</Code>로 목표와 실행 태스크를 생성합니다.</li>
              <li>• 작업 중에는 <Code>crewdeck_update_task</Code>로 진행·검토·완료·차단 상태를 갱신합니다.</li>
              <li>• 생성 결과는 새로고침 없이 왼쪽 목표 목록과 오른쪽 Crewdeck 탭에 나타납니다.</li>
            </ul>
          </Section>

          <Section n="4" title="직접 동기화 명령">
            <p>AI를 거치지 않고 shell에서 직접 조작할 수도 있습니다.</p>
            <div className="space-y-2 rounded-lg border border-line bg-terminal p-3 font-mono text-[11px] text-terminal-fg">
              <div>crewdeck-sync context</div>
              <div>{`crewdeck-sync goal --title '로그인 개선' --tasks-json '[{"title":"API 구현","assignee":"backend"}]'`}</div>
              <div>crewdeck-sync task-status --task-id ID --status in_progress</div>
            </div>
          </Section>

          <Section n="5" title="세션과 안전 경계">
            <ul className="space-y-1.5">
              <li>• 화면을 닫아도 PTY는 살아 있고, 다시 열면 출력과 세션에 재연결됩니다.</li>
              <li>• <Code>+</Code>로 형제 터미널을 추가하고 <Code>■</Code>로 선택한 터미널만 종료합니다.</li>
              <li>• 서버가 재시작되면 재연결할 수 없는 과거 PTY는 <Code>interrupted</Code>로 보존됩니다.</li>
              <li>• AI에는 서버 전체 키가 아닌 해당 Workspace bridge에만 유효한 세션별 토큰이 전달됩니다.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
