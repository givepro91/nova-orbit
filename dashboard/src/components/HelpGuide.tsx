/**
 * 웹 세션 워크스페이스 도움말 모달 — 소환·맥락 주입·2-pane·개입 사용법을 실제 UI 목업으로.
 * crewdeck:open-help 이벤트로 어디서든 열 수 있고, ProjectHome이 마운트를 소유한다.
 * (본문은 개인 운영 도구 특성상 한국어 하드코딩 — 진입 라벨만 i18n.)
 */
import type { ReactNode } from "react";

function Chip({ tone, children }: { tone: "neutral" | "pass" | "fail" | "cond"; children: ReactNode }) {
  const cls = {
    neutral: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
    pass: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
    fail: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
    cond: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  }[tone];
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>{children}</span>;
}

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-baseline gap-2 text-sm font-bold text-gray-800 dark:text-gray-100">
        <span className="font-mono text-xs text-indigo-500 dark:text-indigo-400">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function HelpGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[86vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">💬 웹 세션 워크스페이스</h2>
            <span className="text-xs text-gray-400">사용 가이드</span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 dark:text-gray-500"
            aria-label="닫기"
          >
            ✕
          </button>
        </div>

        {/* scrollable body */}
        <div className="overflow-y-auto px-5 py-5 space-y-6 text-sm text-gray-600 dark:text-gray-300">
          {/* 개요 */}
          <p className="text-gray-700 dark:text-gray-200 leading-relaxed">
            터미널을 켜지 않고 <b className="text-gray-900 dark:text-white">실패하거나 삐끗한 goal·task를 대시보드 안에서 대화로 진단하고 고칩니다.</b> 문제 카드에서 에이전트를 소환하면 그 작업의 맥락(기획서·작업 공간·판정·최근 출력)이 대화에 자동 주입됩니다.
          </p>

          {/* 흐름 */}
          <div className="flex items-stretch gap-1.5 text-center">
            {[
              { t: "⚡ 소환", d: "실패 카드" },
              { t: "맥락 주입", d: "자동" },
              { t: "대화 수정", d: "멀티턴" },
              { t: "⤢ 워크스페이스", d: "변경·판정" },
            ].map((s, i, arr) => (
              <div key={s.t} className="flex items-center flex-1">
                <div className="flex-1 border border-gray-100 dark:border-gray-700 rounded-lg px-2 py-2 bg-gray-50 dark:bg-gray-800/50">
                  <div className="text-xs font-bold text-gray-800 dark:text-gray-100">{s.t}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">{s.d}</div>
                </div>
                {i < arr.length - 1 && <span className="text-indigo-400 px-0.5">→</span>}
              </div>
            ))}
          </div>

          {/* 진입점 */}
          <Section n="진입점" title="어디서 여는가">
            <ul className="space-y-1.5">
              <li className="flex gap-2"><span>💬</span><span><b className="text-gray-800 dark:text-gray-100">에이전트 패널 채팅</b> — 에이전트 탭 → 노드 클릭 → 상세 열기. 빠른 개입용.</span></li>
              <li className="flex gap-2"><span>⚡</span><span><b className="text-gray-800 dark:text-gray-100">실패 카드 소환</b> — 개요/칸반 탭의 이월 태스크에서 원클릭.</span></li>
              <li className="flex gap-2"><span>⤢</span><span><b className="text-gray-800 dark:text-gray-100">독립 작업 공간</b> — 에이전트 상세 헤더의 ⤢ 버튼으로 풀 2-pane 확장.</span></li>
            </ul>
          </Section>

          {/* 소환 */}
          <Section n="1" title="실패 카드에서 소환하기">
            <p>검증에 실패해 <b>이월된 태스크</b>(완료됐지만 이슈가 최종 QA로 넘어간 상태)의 카드에, <span className="font-mono text-xs">↻ 다시 해결</span> 옆에 <span className="font-mono text-xs">⚡ 소환</span> 버튼이 나타납니다. 담당자가 지정된 태스크에만 보입니다.</p>
            <div className="border border-gray-100 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-800/50">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">전투 세이브 partySynergy 버그</span>
                <Chip tone="cond">이슈 이월</Chip>
              </div>
              <div className="flex gap-2 mt-2">
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">↻ 다시 해결</span>
                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 ring-1 ring-indigo-300 dark:ring-indigo-500/40">⚡ 소환</span>
              </div>
            </div>
          </Section>

          {/* 주입 */}
          <Section n="2" title="주입됨 스트립 — 무엇을 읽었는지">
            <p>첫 메시지를 보내면 시스템이 그 goal의 맥락을 읽어 대화에 넣고, <b>무엇을 넣었는지</b> 스레드 맨 위에 칩으로 보여줍니다. 잘못된 맥락을 바로 알아채라고요.</p>
            <div className="flex flex-wrap gap-1.5 items-center border border-indigo-100 dark:border-indigo-500/20 rounded-lg px-3 py-2 bg-indigo-50/70 dark:bg-indigo-500/10">
              <span className="text-[11px] font-bold text-indigo-500 dark:text-indigo-300 font-mono">⚡ 주입됨</span>
              <Chip tone="neutral">기획서</Chip>
              <Chip tone="neutral">작업 공간: goal/feat-x</Chip>
              <Chip tone="fail">판정: fail</Chip>
              <Chip tone="neutral">최근 출력</Chip>
            </div>
          </Section>

          {/* 워크스페이스 */}
          <Section n="3" title="독립 작업 공간 (⤢) — 2-pane">
            <p>상세 헤더의 <span className="font-mono text-xs">⤢</span> 버튼으로 풀스크린 워크스페이스를 엽니다. <b>왼쪽은 대화, 오른쪽은 4개 탭</b>입니다:</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { t: "변경", d: "작업 공간의 git diff (추가 초록/삭제 빨강)" },
                { t: "최근 출력", d: "에이전트 실시간 활동·터미널" },
                { t: "작업 공간", d: "worktree 파일 목록" },
                { t: "판정", d: "검증 라운드 타임라인" },
              ].map((x) => (
                <div key={x.t} className="border border-gray-100 dark:border-gray-700 rounded-lg px-3 py-2 bg-white dark:bg-gray-800">
                  <div className="text-xs font-bold text-gray-800 dark:text-gray-100">{x.t}</div>
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{x.d}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* 개입 */}
          <Section n="4" title="실행 중 개입 — 큐 & 중단">
            <p>에이전트가 응답하는 중에도 입력창이 막히지 않습니다:</p>
            <ul className="space-y-1.5">
              <li className="flex gap-2"><span className="font-mono text-indigo-500 dark:text-indigo-400 text-xs shrink-0">⌘⏎</span><span><b>대기 중</b> — 바로 전송.</span></li>
              <li className="flex gap-2"><span className="font-mono text-indigo-500 dark:text-indigo-400 text-xs shrink-0">⌘⏎</span><span><b>실행 중</b> — 메시지가 <b>큐에 쌓이고</b> 턴이 끝나면 자동 전송. 하단에 <span className="font-mono text-[11px]">큐 N개 대기 중</span> 칩.</span></li>
              <li className="flex gap-2"><span className="font-mono text-indigo-500 dark:text-indigo-400 text-xs shrink-0">Esc</span><span><b>중단</b> — 현재 턴을 멈추고 큐를 비웁니다.</span></li>
            </ul>
            <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-l-2 border-amber-400 pl-3 py-2 rounded-r">
              지금은 여기까지입니다. "끼어들기(steer)"와 턴 단위 체크포인트 되돌리기는 다음 단계에서 붙습니다.
            </p>
          </Section>

          {/* 판정 범례 */}
          <Section n="범례" title="판정 배지 읽는 법">
            <p className="text-xs">색은 점수판이 아니라 <b>"어디부터 볼지"</b> 신호입니다. 카드와 주입됨 스트립에서 같은 색을 씁니다.</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex items-center gap-2 border border-gray-100 dark:border-gray-700 rounded-lg px-2.5 py-2">
                <span>🟢</span><div><div className="text-xs font-bold text-gray-800 dark:text-gray-100">통과</div><div className="text-[10px] font-mono text-green-600 dark:text-green-400">pass</div></div>
              </div>
              <div className="flex items-center gap-2 border border-gray-100 dark:border-gray-700 rounded-lg px-2.5 py-2">
                <span>🟡</span><div><div className="text-xs font-bold text-gray-800 dark:text-gray-100">조건부</div><div className="text-[10px] font-mono text-amber-600 dark:text-amber-400">conditional</div></div>
              </div>
              <div className="flex items-center gap-2 border border-gray-100 dark:border-gray-700 rounded-lg px-2.5 py-2">
                <span>🔴</span><div><div className="text-xs font-bold text-gray-800 dark:text-gray-100">실패</div><div className="text-[10px] font-mono text-red-600 dark:text-red-400">fail</div></div>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
