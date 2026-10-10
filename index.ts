/**
 * pi-lean-memo — tiny persistent memory for Pi.
 *
 * Design goal: <200 tokens base overhead (one small `memo` tool).
 * - Global memory: ~/.pi/agent/TODO.md (always)
 * - Project memory: <cwd>/TODO.md + <cwd>/.pi/TODO.md (when present);
 *   ephemeral cwds (/tmp, /dev/shm, $TMPDIR) redirect to
 *   ~/.pi/agent/project-todos/<encoded-cwd>.md — never tmpfs.
 * - Each entry attaches its origin chat (session id), so recall needs
 *   no read-other-chats scan. `memo why <id>` resolves that one chat only.
 * - session_start only notifies (0 tokens). before_agent_start injects
 *   a compact `memory` section only when files are non-empty.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

function agentDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  if (base.endsWith("agent")) return base;
  return join(base, "agent");
}

function globalFile(): string {
  return join(agentDir(), "TODO.md");
}

// tmpfs guard: /tmp is tmpfs here, so project TODOs under ephemeral
// roots redirect to a persistent per-project file instead.
function isEphemeralPath(p: string): boolean {
  const roots = ["/tmp/", "/dev/shm/", "/run/", tmpdir() + sep];
  if (p === "/tmp" || p === "/dev/shm") return true;
  if (process.env.TMPDIR && p.startsWith(process.env.TMPDIR)) return true;
  return roots.some((r) => p.startsWith(r));
}

function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/[\\/:]/g, "-") + "--";
}

function persistentProjectFile(cwd: string): string {
  return join(agentDir(), "project-todos", encodeCwd(cwd) + ".md");
}

function projectFiles(cwd: string): string[] {
  if (isEphemeralPath(cwd)) return [persistentProjectFile(cwd)];
  const out = [join(cwd, "TODO.md"), join(cwd, ".pi", "TODO.md")];
  return out.filter((p) => p !== globalFile());
}

function allFiles(cwd: string): { tag: string; path: string }[] {
  const g = globalFile();
  const rest = projectFiles(cwd).filter((p) => p !== g);
  return [{ tag: "G", path: g }, { tag: "P", path: rest[0] }, { tag: "L", path: rest[1] }];
}

const MEMO_RE = /^(\s*-\s\[( |x)\]\s+)(.*)$/;
const CHAT_RE = /chat:([A-Za-z0-9-]{4,})/;

interface Memo {
  id: string;
  file: string;
  tag: string;
  line: number; // 1-based file line
  done: boolean;
  text: string; // stripped of html comment
  chat?: string;
}

function parseFile(tag: string, path: string): Memo[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Memo[] = [];
  const lines = raw.split("\n");
  let n = 0;
  lines.forEach((ln, i) => {
    const m = ln.match(MEMO_RE);
    if (!m) return;
    n++;
    const body = m[3] ?? "";
    const text = body.replace(/<!--.*?-->/g, "").trim();
    const cm = body.match(CHAT_RE);
    out.push({ id: `${tag}${n}`, file: path, tag, line: i + 1, done: m[2] === "x", text, chat: cm?.[1] });
  });
  return out;
}

function listAll(cwd: string): Memo[] {
  const out: Memo[] = [];
  for (const f of allFiles(cwd)) out.push(...parseFile(f.tag, f.path));
  return out;
}

function compactLine(m: Memo): string {
  return `${m.done ? "x" : " "} ${m.id}: ${m.text.slice(0, 120)}`;
}

function ensureDir(path: string) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function findSessionFile(chatId: string): string | undefined {
  const base = process.env.PI_CODING_AGENT_DIR
    ? join(process.env.PI_CODING_AGENT_DIR, "sessions")
    : join(homedir(), ".pi", "agent", "sessions");
  try {
    const dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      const files = readdirSync(join(base, d.name));
      const hit = files.find((f) => f.includes(chatId));
      if (hit) return join(base, d.name, hit);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function firstUserLine(sessionFile: string): string {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const nl = raw.indexOf("\n");
    const rest = nl >= 0 ? raw.slice(nl + 1) : raw;
    // scan first 60 lines for first user message, parse minimally
    const lines = rest.split("\n").slice(0, 60);
    for (const ln of lines) {
      if (!ln.includes('"role":"user"') && !ln.includes('"role": "user"')) continue;
      try {
        const e = JSON.parse(ln);
        const c = (e as any).message?.content;
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? "").join("\n") : "";
        if (txt.trim()) return txt.slice(0, 500);
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

const MemoParams = Type.Object({
  action: StringEnum(["list", "add", "done", "drop", "why"] as const),
  text: Type.Optional(Type.String({ description: "Text for add" })),
  id: Type.Optional(Type.String({ description: "ID like G1" })),
  scope: Type.Optional(StringEnum(["global", "project"] as const)),
});

export default function (pi: ExtensionAPI) {
  let cached = "";

  pi.on("session_start", (_e, ctx) => {
    const memos = listAll(ctx.cwd);
    const g = memos.filter((m) => m.tag === "G").length;
    const p = memos.length - g;
    cached = memos.map(compactLine).join("\n").slice(0, 1500);
    if (memos.length > 0 && ctx.hasUI) {
      try {
        ctx.ui.notify(`Memory: ${memos.length} item(s) (global ${g}, project ${p}) — memo list`, "info");
      } catch {
        /* non-interactive */
      }
    }
  });

  pi.on("before_agent_start", (event) => {
    const sections = (event.systemPromptOptions as any)?.sections;
    if (!sections) return;
    if (!cached.trim()) {
      delete sections.memory;
      return;
    }
    sections.memory = `Persistent memory (TODO.md, long-term, no transcript search needed). Use memo tool to update.\n${cached}`;
  });

  pi.registerTool({
    name: "memo",
    label: "Memo",
    description: "Persistent TODO memory. Actions: list, add, done, drop, why.",
    parameters: MemoParams,
    async execute(_id, params: any, _sig, _upd, ctx: any) {
      const cwd: string = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
      const action = params?.action as string;
      if (action === "list") {
        const memos = listAll(cwd);
        cached = memos.map(compactLine).join("\n").slice(0, 1500);
        const txt = memos.length ? memos.map(compactLine).join("\n") : "No memos";
        return { content: [{ type: "text" as const, text: txt }], details: undefined };
      }
      if (action === "add") {
        const text = String(params?.text ?? "").trim().replace(/\n+/g, " ").slice(0, 300);
        if (!text) throw new Error("text required for add");
        const scope = params?.scope === "project" ? "project" : "global";
        const target = scope === "project" ? projectFiles(cwd)[0] : globalFile();
        if (isEphemeralPath(target)) throw new Error(`Refusing tmpfs target ${target}`);
        ensureDir(target);
        let sid = "";
        try {
          sid = ctx?.sessionManager?.getSessionId?.() ?? "";
        } catch {
          sid = "";
        }
        const short = sid ? sid.slice(0, 8) : "manual";
        const line = `- [ ] ${text} <!-- chat:${short} date:${today()} -->\n`;
        if (!existsSync(target)) writeFileSync(target, "# TODO\n\n", "utf8");
        appendFileSync(target, line, "utf8");
        const memos = listAll(cwd);
        cached = memos.map(compactLine).join("\n").slice(0, 1500);
        return { content: [{ type: "text" as const, text: `Saved to ${scope} (${target})` }], details: undefined };
      }
      const mid = String(params?.id ?? "").trim().toUpperCase();
      if (!mid) throw new Error("id required (e.g. G1)");
      const memos = listAll(cwd);
      const m = memos.find((x) => x.id === mid);
      if (!m) throw new Error(`Unknown id ${mid}. Use memo list first.`);
      if (action === "why") {
        if (!m.chat) return { content: [{ type: "text" as const, text: `${m.id}: no chat attached` }], details: undefined };
        const f = findSessionFile(m.chat);
        if (!f) return { content: [{ type: "text" as const, text: `${m.id}: chat ${m.chat} (file pruned)` }], details: undefined };
        const snippet = firstUserLine(f);
        const txt = `${m.id}: ${m.text}\nchat: ${m.chat}\nsession: ${f}\nfirst ask: ${snippet || "(unreadable)"}`;
        return { content: [{ type: "text" as const, text: txt }], details: undefined };
      }
      // done / drop: rewrite file line
      const lines = readFileSync(m.file, "utf8").split("\n");
      const idx = m.line - 1;
      if (action === "done") lines[idx] = lines[idx].replace(/-\s\[\s\]/, "- [x]");
      else if (action === "drop") lines.splice(idx, 1);
      else throw new Error(`Unknown action ${action}`);
      writeFileSync(m.file, lines.join("\n"), "utf8");
      cached = listAll(cwd).map(compactLine).join("\n").slice(0, 1500);
      return { content: [{ type: "text" as const, text: `${action} ${m.id} ok` }], details: undefined };
    },
  });

  pi.registerCommand("remember", {
    description: "Save text to global TODO memory. Usage: /remember <fact>",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /remember <fact>", "error");
        return;
      }
      const t = globalFile();
      ensureDir(t);
      if (!existsSync(t)) writeFileSync(t, "# TODO\n\n", "utf8");
      let sid = "";
      try {
        sid = (ctx as any).sessionManager?.getSessionId?.() ?? "";
      } catch {
        sid = "";
      }
      appendFileSync(t, `- [ ] ${text.slice(0, 300)} <!-- chat:${(sid || "manual").slice(0, 8)} date:${today()} -->\n`, "utf8");
      ctx.ui.notify(`Saved to ${t}`, "info");
    },
  });

  pi.registerCommand("memos", {
    description: "Show global + project TODO memory",
    handler: async (_args, ctx) => {
      const memos = listAll(ctx.cwd);
      ctx.ui.notify(memos.length ? memos.map(compactLine).join("\n") : "No memos", "info");
    },
  });

  pi.registerCommand("forget", {
    description: "Delete one memo by ID. Usage: /forget G1",
    handler: async (args, ctx) => {
      const mid = args.trim().toUpperCase();
      const memos = listAll(ctx.cwd);
      const m = memos.find((x) => x.id === mid);
      if (!m) {
        ctx.ui.notify(`Unknown id ${mid}`, "error");
        return;
      }
      const lines = readFileSync(m.file, "utf8").split("\n");
      lines.splice(m.line - 1, 1);
      writeFileSync(m.file, lines.join("\n"), "utf8");
      ctx.ui.notify(`Dropped ${m.id}`, "info");
    },
  });
}
