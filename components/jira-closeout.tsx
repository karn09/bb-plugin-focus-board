// The Jira closeout overlay: after a thread's Done passes, nothing posts to
// Jira until the operator approves this draft (Post & close / Skip Jira /
// Later). Mounted once by the app inside JiraBoardContext; opens by itself
// only for a thread this board just moved to Done, else from the card's
// "Closeout pending" chip. Every body is untrusted text: rendered as text only.
import { useContext, useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { JiraBoardContext, JiraLozenge } from "./jira-card-badges";
import { CLOSEOUT_MAX, type CloseoutDraft } from "../lib/jira-done-check";

type Result = Promise<{ ok: boolean; error?: string }>;
export type JiraCloseoutValue = {
  /** threadId → draft (jira_board_state.closeouts). */
  drafts: Record<string, CloseoutDraft>;
  /** Thread ids this board sent done=true for; the overlay opens (and forgets the id) once a draft lands. */
  // ponytail: an id whose Done made no draft stays until the next draft for it; fine while CLI drafts are rare.
  doneRequested: Set<string>;
  openFor: string | null;
  setOpenFor: (threadId: string | null) => void;
  submit: (threadId: string, tickets: { key: string; body: string; transition: boolean }[]) => Result;
  skip: (threadId: string) => Result;
  draftWithAgent: (threadId: string, instruction?: string) => Result;
};

export function JiraCloseoutSlot() {
  const v = useContext(JiraBoardContext);
  const c = v?.enabled ? v.closeout : undefined;
  useEffect(() => {
    if (!c) return;
    for (const id of c.doneRequested) {
      if (c.drafts[id] === undefined) continue;
      c.doneRequested.delete(id);
      if (c.openFor === null) c.setOpenFor(id);
    }
  }, [c]);
  if (!v || !c || c.openFor === null) return null;
  const d = c.drafts[c.openFor];
  if (!d) return null;
  return <CloseoutDialog key={c.openFor} threadId={c.openFor} draft={d} c={c} ticketByKey={v.ticketByKey} />;
}

type Row = { body: string; transition: boolean; dirty: boolean; ready?: string };

function CloseoutDialog({ threadId, draft, c, ticketByKey }: { threadId: string; draft: CloseoutDraft; c: JiraCloseoutValue; ticketByKey: Record<string, { status: string; statusCategory: "new" | "indeterminate" | "done" }> }) {
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(draft.tickets.map((t) => [t.key, { body: t.body, transition: t.transition, dirty: false }])));
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintBase = useId();
  // A new server body (the agent's draft) replaces an untouched textarea; an edited one gets "Use it".
  const seen = useRef(Object.fromEntries(draft.tickets.map((t) => [t.key, t.body])));
  useEffect(() => {
    const changed = draft.tickets.filter((t) => seen.current[t.key] !== t.body);
    if (changed.length === 0) return;
    for (const t of changed) seen.current[t.key] = t.body;
    setRows((cur) => {
      const next = { ...cur };
      for (const t of changed) {
        const r = next[t.key];
        if (r) next[t.key] = r.dirty ? { ...r, ready: t.body } : { ...r, body: t.body, ready: undefined };
      }
      return next;
    });
  }, [draft]);
  const update = (key: string, patch: Partial<Row>) => setRows((cur) => ({ ...cur, [key]: { ...cur[key]!, ...patch } }));
  const close = () => c.setOpenFor(null);
  const run = async (call: () => Result, closeAfter: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call();
      if (!r.ok) setError(r.error ?? "failed");
      else if (closeAfter) close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const anyMove = draft.tickets.some((t) => rows[t.key]?.transition);
  const post = () =>
    run(() => c.submit(threadId, draft.tickets.map((t) => ({ key: t.key, body: rows[t.key]!.body, transition: rows[t.key]!.transition }))), true);
  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg" data-jira-closeout="">
        <DialogHeader>
          <DialogTitle>Close out in Jira</DialogTitle>
          <DialogDescription>Nothing is posted to Jira until you choose Post. Later keeps this draft on the card.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {draft.tickets.map((t, i) => {
            const r = rows[t.key]!;
            const known = ticketByKey[t.key];
            const hintId = `${hintBase}-${i}`;
            return (
              <section key={t.key} className="flex flex-col gap-1" data-closeout-ticket={t.key}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono">{t.key}</span>
                  {r.transition ? <JiraLozenge status="Done" category="done" /> : known ? <JiraLozenge status={known.status} category={known.statusCategory} /> : null}
                </div>
                <textarea
                  aria-label={`Comment for ${t.key}`}
                  className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                  maxLength={CLOSEOUT_MAX}
                  value={r.body}
                  onChange={(e) => update(t.key, { body: e.target.value, dirty: true })}
                />
                {r.ready !== undefined ? (
                  <p className="text-xs text-muted-foreground">
                    Agent draft ready —{" "}
                    <button type="button" className="underline" onClick={() => update(t.key, { body: r.ready!, dirty: false, ready: undefined })}>
                      Use it
                    </button>
                  </p>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={r.transition}
                    disabled={!t.canTransition}
                    aria-describedby={t.canTransition ? undefined : hintId}
                    onChange={(e) => update(t.key, { transition: e.target.checked })}
                  />
                  Move {t.key} to Done
                </label>
                {t.canTransition ? null : (
                  <span id={hintId} className="text-xs text-muted-foreground">
                    Can't move it: {t.blocked ?? "not allowed"}
                  </span>
                )}
              </section>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <input
            aria-label="Instruction for the agent"
            className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
            placeholder="Ask the agent to rewrite… (e.g. shorter, mention the runbook)"
            maxLength={500}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => c.draftWithAgent(threadId, instruction.trim() || undefined), false)}>
            Draft with agent
          </Button>
        </div>
        {draft.agentDrafting ? (
          <p role="status" className="text-xs text-muted-foreground">
            The agent is drafting…
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            Later
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => c.skip(threadId), true)}>
            Skip Jira
          </Button>
          <Button size="sm" disabled={busy} onClick={post}>
            {anyMove ? "Post & close" : "Post"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
