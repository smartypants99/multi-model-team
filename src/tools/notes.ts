/**
 * Per-member scratch notes for document work types (research, writing, planning).
 * Each member has its own notes; anyone can read anyone's, only the owner writes.
 */
import type { ToolDefinition } from "../core/types.js";

export class NotesStore {
  private notes = new Map<string, Map<string, string>>();
  get(memberId: string, name: string): string | undefined {
    return this.notes.get(memberId)?.get(name);
  }
  set(memberId: string, name: string, text: string): void {
    if (!this.notes.has(memberId)) this.notes.set(memberId, new Map());
    this.notes.get(memberId)!.set(name, text);
  }
  list(memberId: string): string[] {
    return [...(this.notes.get(memberId)?.keys() ?? [])];
  }
  all(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [m, map] of this.notes) out[m] = Object.fromEntries(map);
    return out;
  }
}

export function notesTools(store: NotesStore, labelOf: (memberId: string) => string, idOfLabel: (label: string) => string | undefined): ToolDefinition[] {
  return [
    {
      schema: {
        name: "write_notes",
        description: "Save a named note in your own notebook (overwrites). Use it to keep sources, drafts and findings.",
        parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] },
      },
      async execute(args, ctx) {
        const name = String(args.name ?? "").slice(0, 100);
        if (!name) return "error: name required";
        store.set(ctx.member.id, name, String(args.content ?? ""));
        return `saved note "${name}" (${String(args.content ?? "").length} chars)`;
      },
    },
    {
      schema: {
        name: "read_notes",
        description: "Read a note. Omit 'agent' to read your own; pass an agent label (e.g. 'Agent B') to read another agent's note. Omit 'name' to list note names.",
        parameters: { type: "object", properties: { name: { type: "string" }, agent: { type: "string" } }, required: [] },
      },
      async execute(args, ctx) {
        const owner = args.agent ? idOfLabel(String(args.agent)) : ctx.member.id;
        if (!owner) return `error: unknown agent ${String(args.agent)}`;
        if (!args.name) return `notes of ${labelOf(owner)}: ${store.list(owner).join(", ") || "(none)"}`;
        const text = store.get(owner, String(args.name));
        return text === undefined ? `error: no note named "${String(args.name)}"` : text;
      },
    },
  ];
}
