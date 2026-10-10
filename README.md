# pi-lean-memo

Tiny persistent TODO memory. One `memo` tool (~120 tokens base).

## Files

- Global: `~/.pi/agent/TODO.md` (always)
- Project: `<cwd>/TODO.md` and `<cwd>/.pi/TODO.md` (when present)

## Why lean

- 1 tool, 4 params, short strings. No skill.
- `session_start` only notifies. Zero tokens when empty.
- `before_agent_start` injects compact `memory` section only when non-empty.
- Recall needs no transcript scan. Each line attaches `chat:<sessionId>`.

## Tool

`memo action=list|add|done|drop|why text? id? scope?`

- `list` → `G1: text`, `P1: text`
- `add text scope=global|project` → appends `- [ ] text <!-- chat:<sid> date:<d> -->`
- `done|drop id` → check off or delete
- `why id` → origin chat + session file + first ask (one file read only)

## Commands (0 base tokens)

- `/remember <fact>` → global
- `/memos` → show all
- `/forget <G1>` → delete

## Long-term memory use

Tell the agent: "remember X". It calls `memo add`.
Next session auto-injects the compact list. No read-other-chats needed.
`memo why G3` attaches the specific chat that created it.
