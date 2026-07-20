import { describe, expect, it } from "vitest";
import { mouseModeSequence } from "../core/terminal/tmux.js";
import { sanitizeReplayOutput } from "../core/terminal/escape-filter.js";

// 플래그 순서 = #{mouse_standard_flag}#{mouse_button_flag}#{mouse_all_flag}#{mouse_utf8_flag}#{mouse_sgr_flag}
describe("mouseModeSequence", () => {
  it("restores nothing when the pane has no mouse tracking", () => {
    expect(mouseModeSequence("00000")).toBe("");
  });

  it("restores any-event + SGR tracking (실측: claude TUI가 켜는 조합)", () => {
    expect(mouseModeSequence("00101")).toBe("\x1b[?1003h\x1b[?1006h");
  });

  it("maps each flag to its DEC private mode", () => {
    expect(mouseModeSequence("10000")).toBe("\x1b[?1000h");
    expect(mouseModeSequence("01000")).toBe("\x1b[?1002h");
    expect(mouseModeSequence("00010")).toBe("\x1b[?1005h");
    expect(mouseModeSequence("11111")).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1005h\x1b[?1006h");
  });

  it("treats an empty tmux report as no tracking", () => {
    expect(mouseModeSequence("")).toBe("");
  });

  // 이 시퀀스는 리플레이 sanitizer가 제거하는 대상이다. 그래서 복원은 sanitize를 통과시키는
  // 게 아니라 그 "뒤에" 붙여야 한다 — capture()나 sanitize 이전으로 옮기면 조용히 무효가 된다.
  it("is stripped by the replay sanitizer, so it must be appended after it", () => {
    expect(sanitizeReplayOutput(mouseModeSequence("00101"))).toBe("");
  });
});
