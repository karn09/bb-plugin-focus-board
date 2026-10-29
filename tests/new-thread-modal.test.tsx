// @vitest-environment jsdom
// The board's in-board new-thread composer modal: renders bb's host
// NewThreadComposer inside the responsive dialog, spawns through the SDK on
// submit, closes and hands the new thread to the board on success, and keeps
// the modal (and the composer's draft) on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewThreadModal } from "../components/new-thread-modal";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";

const spawn = vi.fn();
const onOpenChange = vi.fn();
const onSpawned = vi.fn();
const onMaximize = vi.fn();
const rememberProjectId = vi.fn();
const rememberEnvironment = vi.fn();

// The submit request is opaque to the modal (it forwards verbatim to
// spawn), so the test builds a minimal one and casts. The environment field
// rides along: the remember-environment test asserts the modally-resolved
// environment itself is handed over, not a lib derivation.
const REQUEST = {
  projectId: "proj_1",
  environment: { type: "project-default" },
  input: [],
} as unknown as NewThreadRequest;

// The spawn result fields the modal and the board's provisional pane row
// read; extra ThreadResponse fields are irrelevant here.
const SPAWNED = {
  id: "thr_new",
  title: null,
  titleFallback: "Fresh thread",
  status: "pending" as const,
  projectId: "proj_1",
};

let lastComposerProps: Record<string, unknown> | null = null;
let lastSubmitPromise: Promise<void> | null = null;

vi.mock("@get-bb/plugin-sdk/app", () => ({
  // A stub composer: records the props it was seeded with and offers a
  // button that fires onSubmit, the way the host composer would on submit.
  experimental_NewThreadComposer: (props: Record<string, unknown>): ReactNode => {
    lastComposerProps = props;
    return createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          lastSubmitPromise = Promise.resolve(
            (props.onSubmit as (request: NewThreadRequest) => Promise<void>)(REQUEST),
          );
        },
      },
      "Stub composer submit",
    );
  },
  useSdk: () => ({ threads: { spawn } }),
}));

beforeEach(() => {
  spawn.mockReset();
  spawn.mockResolvedValue(SPAWNED);
  onOpenChange.mockReset();
  onSpawned.mockReset();
  onMaximize.mockReset();
  rememberProjectId.mockReset();
  rememberEnvironment.mockReset();
  lastComposerProps = null;
  lastSubmitPromise = null;
});

afterEach(cleanup);

function renderModal(
  {
    open = true,
    defaultProjectId,
    defaultEnvironment,
    defaultProviderId,
    defaultModel,
    focusRequest,
    parentThreadId,
    parentThreadTitle,
    parentGroupName,
    groupName,
    withMaximize = false,
    rememberProjectId,
    rememberEnvironment,
  }: {
    open?: boolean;
    defaultProjectId?: string;
    defaultEnvironment?: Record<string, unknown>;
    defaultProviderId?: string;
    defaultModel?: string;
    focusRequest?: number;
    parentThreadId?: string;
    parentThreadTitle?: string;
    parentGroupName?: string;
    groupName?: string;
    withMaximize?: boolean;
    rememberProjectId?: ReturnType<typeof vi.fn>;
    rememberEnvironment?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return render(
    createElement(NewThreadModal, {
      open,
      onOpenChange,
      defaultProjectId,
      defaultEnvironment,
      defaultProviderId,
      defaultModel,
      focusRequest,
      parentThreadId,
      parentThreadTitle,
      ...(parentGroupName !== undefined ? { parentGroupName } : {}),
      ...(groupName !== undefined ? { groupName } : {}),
      onSpawned,
      ...(rememberProjectId !== undefined ? { rememberProjectId } : {}),
      ...(rememberEnvironment !== undefined ? { rememberEnvironment } : {}),
      // A child preset cannot follow to the main view; the app passes the
      // handler only for root threads, mirrored here by the flag.
      onMaximize: withMaximize ? onMaximize : undefined,
    }),
  );
}

const submitButton = () => {
  const button = document.querySelector<HTMLButtonElement>(
    'button[type="button"]:not([aria-label="Close"]):not([aria-label="Maximize new thread"])',
  );
  if (button === null) throw new Error("stub composer submit button not rendered");
  return button;
};

describe("NewThreadModal", () => {
  it("renders the composer only while open", () => {
    const view = renderModal({ open: true });
    expect(view.getByText("Stub composer submit")).toBeTruthy();
    view.rerender(
      createElement(NewThreadModal, {
        open: false,
        onOpenChange,
        onSpawned,
      }),
    );
    expect(view.queryByText("Stub composer submit")).toBeNull();
  });

  it("leaves the composer's popup menus unclipped: no scroll/hidden overflow ancestor between the composer and the dialog", () => {
    // Why a DOM-structure test and not a rendered check: jsdom cannot measure
    // clipping (no layout), so this asserts the invariant the modal controls:
    // any ancestor of the composer form with overflow other than visible
    // clips the host composer's typeahead menu. Proof from the real browser
    // (desktop tab, 1280x720): the host menu renders position:absolute
    // `bottom-full` against the promptbox form — for "Ask anything." at
    // y=306, the @-menu rect was y=265..299 (above the form; the menu
    // escapes static siblings like the host's own data-promptbox-main
    // because its containing block is the form) — but the modal's
    // max-h-[70vh] overflow-y-auto wrapper sat at y=306..470 and IS an
    // ancestor of that containing block, so it erased the menu entirely
    // (menu in the DOM, invisible; bb's main view and the board's chat-pane
    // composer, which have no clipping ancestor above the prompt form, show
    // the same menu fine). The same clipping path also erased the composer's
    // "/" command menu. No wrapper — the menu escapes to overlap the dialog
    // freely.
    renderModal({ open: true });
    const composer = document.querySelector('button[type="button"]:not([aria-label="Close"]):not([aria-label="Maximize new thread"])');
    expect(composer).not.toBeNull();
    const dialog = composer!.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const clipping = /overflow-(y-auto|auto|y-clip|clip|y-hidden|hidden)\b/;
    const offenders: string[] = [];
    for (
      let node: Element | null = composer!.parentElement;
      node && node !== dialog;
      node = node.parentElement
    ) {
      const className = typeof node.className === "string" ? node.className : "";
      if (clipping.test(className)) offenders.push(className);
    }
    expect(offenders).toEqual([]);
  });

  it("seeds the composer with the project from the board filter", () => {
    renderModal({ defaultProjectId: "proj_a", focusRequest: 3 });
    expect(lastComposerProps).not.toBeNull();
    expect(lastComposerProps?.defaultProjectId).toBe("proj_a");
    expect(lastComposerProps?.focusRequest).toBe(3);
  });

  it("spawns on submit, closes the modal, and hands the thread to the board", async () => {
    renderModal();
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith(SPAWNED);
    });
    expect(spawn).toHaveBeenCalledWith(REQUEST);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with a parent preset, spawns the submitted request as that thread's child", async () => {
    renderModal({ parentThreadId: "thr_root", parentThreadTitle: "Root epic" });
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith(SPAWNED);
    });
    // The parent rides on the verbatim request — the child fields (prompt,
    // project, environment, provider) stay whatever the operator composed.
    expect(spawn).toHaveBeenCalledWith({
      projectId: "proj_1",
      environment: REQUEST.environment,
      input: [],
      parentThreadId: "thr_root",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("with a parent preset, titles the dialog and names the nesting target", () => {
    renderModal({ parentThreadId: "thr_root", parentThreadTitle: "Root epic" });
    expect(screen.getByText("New child thread")).toBeTruthy();
    const hint = document.querySelector('[data-new-child-hint=""]');
    if (hint === null) throw new Error("parent hint not rendered");
    expect(hint.textContent).toContain("Will nest under");
    expect(hint.textContent).toContain("Root epic");
  });

  it("with a parent preset, the composer still receives the project seed", () => {
    // The seed itself is app-level (lib/new-thread-seed: the parent's
    // project wins over the filter); the modal's contract is that both the
    // parent preset and the seed reach the composer at once.
    renderModal({
      parentThreadId: "thr_root",
      parentThreadTitle: "Root epic",
      defaultProjectId: "proj_home",
    });
    expect(lastComposerProps?.defaultProjectId).toBe("proj_home");
    expect(screen.getByText("New child thread")).toBeTruthy();
  });

  it("forwards an environment seed to the composer", () => {
    // The parent's worktree checkout, as a `reuse` environment: the composer
    // seeds its environment picker so the child starts in the parent's
    // checkout rather than the project-default one.
    renderModal({
      parentThreadId: "thr_root",
      defaultEnvironment: { type: "reuse", environmentId: "env_1" },
    });
    expect(lastComposerProps?.defaultEnvironment).toEqual({
      type: "reuse",
      environmentId: "env_1",
    });
  });

  it("maximizes into the main new-thread view when the app provides the hand-off", () => {
    renderModal({ withMaximize: true });
    const maximize = screen.getByLabelText("Maximize new thread");
    expect(maximize.getAttribute("title")).toBe("Open in the main new-thread view");
    fireEvent.click(maximize);
    expect(onMaximize).toHaveBeenCalledTimes(1);
    // The hand-off does not submit: nothing spawns.
    expect(spawn).not.toHaveBeenCalled();
    expect(onSpawned).not.toHaveBeenCalled();
  });

  it("insets the maximize button clear of the dialog's own close", () => {
    // The 2026-10-23 release screenshot caught the maximize button abutting
    // the dialog's close: both boxes render 32px wide, maximize at right-12
    // and the close at right-4, so their edges met at exactly 0px and the pair
    // read as one control. jsdom has no layout, so the guard is the offset
    // contract, and the harness measured a 16px gap once the inset moved to
    // right-16.
    renderModal({ withMaximize: true });
    const maximize = screen.getByLabelText("Maximize new thread");
    expect(maximize.className).toContain("right-16");
    expect(maximize.className).not.toContain("right-12");
  });

  it("without a hand-off handler, carries no maximize button (inverse)", () => {
    renderModal();
    expect(screen.queryByLabelText("Maximize new thread")).toBeNull();
  });

  it("without an environment seed, passes nothing to the composer (inverse)", () => {
    renderModal({ parentThreadId: "thr_root" });
    expect("defaultEnvironment" in (lastComposerProps ?? {})).toBe(false);
  });

  it("without a parent, keeps the plain title and no nesting hint (inverse)", () => {
    renderModal();
    expect(screen.getByText("New thread")).toBeTruthy();
    expect(document.querySelector('[data-new-child-hint=""]')).toBeNull();
    expect(screen.queryByText("New child thread")).toBeNull();
  });

  it("hands the spawned thread's project to the board's remember-memory on success", async () => {
    // The spawn success path is where the board's remembered-project rung
    // is fed: the spawn result carries the project the thread landed in.
    renderModal({ rememberProjectId });
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith(SPAWNED);
    });
    expect(rememberProjectId).toHaveBeenCalledTimes(1);
    expect(rememberProjectId).toHaveBeenCalledWith("proj_1");
  });

  it("hands the submitted environment to the board's remember-memory on success", async () => {
    // The environment the composer RESOLVED (a "(new) worktree" pick or a
    // reuse) reaches the board only through the submit request; the spawn
    // result carries no environment. The success path feeds it to the
    // per-project remembered-environment rung alongside the project.
    renderModal({ rememberEnvironment });
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith(SPAWNED);
    });
    expect(rememberEnvironment).toHaveBeenCalledTimes(1);
    expect(rememberEnvironment).toHaveBeenCalledWith("proj_1", REQUEST.environment);
  });

  it("a failed spawn remembers the environment never (inverse)", async () => {
    spawn.mockRejectedValue(new Error("spawn failed"));
    renderModal({ rememberEnvironment });
    fireEvent.click(submitButton());
    await expect(lastSubmitPromise).rejects.toThrow("spawn failed");
    expect(rememberEnvironment).not.toHaveBeenCalled();
  });

  it("a failed spawn remembers nothing (inverse)", async () => {
    spawn.mockRejectedValue(new Error("spawn failed"));
    renderModal({ rememberProjectId });
    fireEvent.click(submitButton());
    await expect(lastSubmitPromise).rejects.toThrow("spawn failed");
    expect(rememberProjectId).not.toHaveBeenCalled();
  });

  it("without a remember-memory callback, submits fine (inverse)", async () => {
    renderModal();
    fireEvent.click(submitButton());
    await waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith(SPAWNED);
    });
  });

  it("on failure keeps the modal open, reports the error, and keeps the draft", async () => {
    spawn.mockRejectedValue(new Error("spawn failed"));
    renderModal();
    fireEvent.click(submitButton());
    // The SDK keeps the composer draft only when onSubmit throws, so the
    // rejection must propagate out of the modal's handler.
    await expect(lastSubmitPromise).rejects.toThrow("spawn failed");
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')).not.toBeNull();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSpawned).not.toHaveBeenCalled();
    // The composer must still be mounted so the kept draft stays editable.
    expect(document.querySelector('button[type="button"]')).not.toBeNull();
  });
});

describe("the group preset (New thread in group…)", () => {
  it("names the group the spawn will be tagged into", () => {
    renderModal({ groupName: "Auth rework" });
    const hint = document.querySelector('[data-new-group-hint=""]');
    if (hint === null) throw new Error("group hint not rendered");
    expect(hint.textContent).toContain("Will be tagged into");
    expect(hint.textContent).toContain("Auth rework");
  });

  it("without a group, carries no group hint (inverse)", () => {
    renderModal();
    expect(document.querySelector('[data-new-group-hint=""]')).toBeNull();
  });

  it("seeds the composer's provider and model from the group's majority seed", () => {
    renderModal({ defaultProviderId: "pi_a", defaultModel: "m_a" });
    expect(lastComposerProps?.defaultProviderId).toBe("pi_a");
    expect(lastComposerProps?.defaultModel).toBe("m_a");
  });

  it("without majority seeds, passes nothing to the composer (inverse)", () => {
    renderModal({ groupName: "Auth rework" });
    expect("defaultProviderId" in (lastComposerProps ?? {})).toBe(false);
    expect("defaultModel" in (lastComposerProps ?? {})).toBe(false);
  });
});

describe("the child preset's group inheritance (New child thread… from a grouped parent)", () => {
  it("names the parent's group the child will join", () => {
    renderModal({ parentThreadId: "thr_p", parentThreadTitle: "Auth rework", parentGroupName: "Auth rework" });
    const hint = document.querySelector('[data-new-child-group-hint=""]');
    if (hint === null) throw new Error("child group hint not rendered");
    expect(hint.textContent).toContain("Will join the group");
    expect(hint.textContent).toContain("Auth rework");
  });

  it("without the parent being grouped, carries no group hint (inverse)", () => {
    renderModal({ parentThreadId: "thr_p", parentThreadTitle: "Auth rework" });
    expect(document.querySelector('[data-new-child-group-hint=""]')).toBeNull();
  });

  it("a parent-preset thread without a parentGroupName never renders the grouping hint (inverse, root-shaped data)", () => {
    renderModal({ parentThreadId: "thr_p" });
    expect(document.querySelector('[data-new-child-group-hint=""]')).toBeNull();
  });

  it("a grouped child spawn still keeps the nesting hint", () => {
    renderModal({ parentThreadId: "thr_p", parentThreadTitle: "Auth rework", parentGroupName: "Auth rework" });
    expect(document.querySelector('[data-new-child-hint=""]')).not.toBeNull();
  });
  it("a Jira seed prefills the prompt and rides pluginMetadata into the spawn", async () => {
    const pluginMetadata = { jira: { links: [{ key: "PT-1", role: "owner", source: "operator" }] } };
    render(createElement(NewThreadModal, { open: true, onOpenChange, onSpawned, initialPrompt: "PT-1: s", pluginMetadata }));
    expect(lastComposerProps?.initialPrompt).toBe("PT-1: s");
    fireEvent.click(submitButton());
    await lastSubmitPromise;
    expect(spawn).toHaveBeenCalledWith({ ...REQUEST, pluginMetadata });
  });
});
