# Terminal security boundary

Crewdeck terminal bridge credentials are scoped to one active terminal session and its workspace. Requests authenticated with a terminal bridge token must provide the exact `workspaceId` and `terminalSessionId`; mutations additionally verify that the terminal, project, active goal, and active task agree.

## Secret transport and lifetime

- tmux receives terminal environment values through the child process environment. Secret values are never appended to tmux arguments or its configuration.
- The dedicated tmux configuration and socket are owner-only (`0600`). The configuration contains environment variable names only.
- A terminal bridge token is stored as a hash and is revoked when its session exits, is interrupted, or is killed. A persistent tmux session retains the token only while it remains active for restart recovery.
- Terminal activity, decisions, task summaries, bridge events, review findings, and collected git evidence pass through the shared terminal redactor before persistence or API responses.

## Command and path boundary

tmux, git, and shell launches use fixed executables with argument arrays. Workspace paths, terminal IDs, shell paths, and shell arguments are passed as literal arguments rather than interpolated command strings.

## Verification

`server/__tests__/terminal-security.test.ts` records boolean assertions from the tmux process itself to prove that distinct test secrets are present in the environment but absent from both argv and `ps` output. Bridge tests cover wrong-terminal, wrong-workspace, wrong-project, inactive-terminal, and secret-redaction cases.

The bridge token protects the local terminal integration; the global Crewdeck API key remains an administrator credential and is intentionally outside this per-terminal scope.
