"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import ChatView from "@/components/chat/ChatView";
import FrontDoor from "@/components/settings/FrontDoor";
import Loader from "@/components/ui/Loader";
import ConversationList from "@/components/sidebar/ConversationList";
import AuthPanel from "@/components/settings/AuthPanel";
import KeyGate from "@/components/settings/KeyGate";
import SettingsPanel from "@/components/settings/SettingsPanel";
import UnlockBar from "@/components/settings/UnlockBar";
import Palette, { type Command } from "@/components/tuner/Palette";
import RailHandle from "@/components/sidebar/RailHandle";
import StatusStrip from "@/components/tuner/StatusStrip";
import { reconcileSettings } from "@/lib/capabilities";
import { fetchCatalog } from "@/lib/catalog";
import { keyFingerprint, useCredential } from "@/lib/credentials";
import { useConversations, type DialMessage } from "@/lib/conversations";
import { settingsOf } from "@/lib/store";
import { exportConversation } from "@/lib/export";
import { useAccount } from "@/lib/session";
import { DEFAULT_SETTINGS, type ChatSettings, type OpenRouterModel } from "@/lib/types";

/** Stable identity so the derived empty view doesn't remount the chat. */
const EMPTY_MESSAGES: DialMessage[] = [];

/**
 * The shell. Owns the conversation list, the live catalog, and the active
 * thread's settings + messages.
 *
 * The chat renders in a keyed ChatView: remounting per conversation resets
 * useChat's session and its in-memory messages, so histories can never
 * interleave and there's no flash of the previous thread.
 */
export default function Home() {
  const credential = useCredential();

  /*
   * The account and the conversation store depend on each other: a delta has
   * to know which thread is open, and the threads it returns have to land in
   * the sidebar. Neither can be declared after the other, so the two edges go
   * through refs — the same shape as the transport taking the settings ref.
   */
  const openThreadRef = useRef<string | null>(null);
  const convRef = useRef<ReturnType<typeof useConversations> | null>(null);
  const applyDelta = useCallback(
    (threads: Parameters<NonNullable<Parameters<typeof useAccount>[0]["onThreads"]>>[0], removed: string[]) => {
      convRef.current?.applyDelta(threads, removed);
    },
    [],
  );

  const account = useAccount({ openThreadRef, onThreads: applyDelta });

  /**
   * The conversation store only talks to the server once there is an account
   * to talk about and a key to read it with. Before that it stays empty
   * rather than issuing requests that would 401.
   */
  const signedIn = account.ready && account.user !== null && !account.locked;
  const conv = useConversations({
    enabled: signedIn,
    restoreId: account.settings.activeThread,
    onActiveChange: useCallback(
      (id: string | null) => account.updateSettings({ activeThread: id }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- updateSettings is stable
      [],
    ),
  });

  useEffect(() => {
    convRef.current = conv;
    openThreadRef.current = conv.activeId;
  });
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  // Session defaults (model + reasoning + search) rather than hard defaults:
  // a new chat inherits the knobs you were last working with.
  const [settings, setSettings] = useState<ChatSettings>(() => ({
    ...DEFAULT_SETTINGS,
  }));
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * The id the chat is currently writing under, minted here rather than in
   * ChatView. A new thread already has its real id before the first send, so
   * the moment it becomes "active" doesn't change the chat's key — which is
   * what previously remounted ChatView mid-save and blanked the transcript.
   */
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  /** Messages for the active thread, once read from the cloud store. */
  const [loaded, setLoaded] = useState<{
    key: string;
    messages: DialMessage[];
  } | null>(null);

  /**
   * A realtime delta patches the rail, while the open transcript is owned by
   * useChat. The latter needs its own version signal so a conversation changed
   * on another device becomes visible without switching threads.
   *
   * Keyed on `pulled`, not on the sync status. Status settles on *every*
   * reconciliation, and most of them apply nothing: a streaming turn pushes
   * roughly every five seconds, so watching the status meant re-reading the
   * whole conversations table and replacing the array — re-rendering the
   * entire rail — several times per answer to discover nothing had changed.
   * `pulled` increments only when remote records were applied, which is
   * precisely the condition this effect exists for, and is already what
   * ChatView uses to re-read the open thread.
   */
  /**
   * A new chat inherits the knobs last used, and those now travel with the
   * account rather than sitting in this browser. Seeded once, when the
   * settings blob first arrives — later edits must not reach back and
   * rewrite the thread the user is looking at.
   */
  const seededDefaults = useRef(false);
  useEffect(() => {
    if (seededDefaults.current || !account.ready || !account.user) return;
    seededDefaults.current = true;
    setSettings((current) => ({ ...current, ...account.settings.defaults }));
  }, [account.ready, account.user, account.settings.defaults]);

  /* ------------------------------ catalog ------------------------------ */

  // The catalog is a public endpoint, so it loads without a key — which is
  // what lets the model list be populated behind the connect screen.
  useEffect(() => {
    const controller = new AbortController();
    fetchCatalog(controller.signal)
      .then(setModels)
      .catch(() => setModels([]));
    return () => controller.abort();
  }, []);

  /* ------------------------- active conversation ----------------------- */

  useEffect(() => {
    const id = conv.activeId;
    // An empty thread needs no read — it is derived below, not stored. Nor
    // does the draft: ChatView holds its live state and is authoritative,
    // so re-reading it here would overwrite a streaming thread with D1.
    if (!conv.ready || !id || id === draftId) return;
    let cancelled = false;

    void Promise.all([conv.getMeta(id), conv.loadMessages(id)]).then(
      ([meta, messages]) => {
        if (cancelled) return;
        setSettings(settingsOf(meta));
        setLoaded({ key: id, messages });
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-resolve when the active thread changes
  }, [conv.ready, conv.activeId, draftId]);

  /**
   * What the chat actually renders. The empty state is derived rather than
   * stored — writing it from an effect would cascade an extra render on
   * every "new chat", and there is nothing to load.
   */
  const view: { key: string; messages: DialMessage[] } | null =
    conv.activeId === null || conv.activeId === draftId
      ? conv.ready
        ? { key: draftId, messages: EMPTY_MESSAGES }
        : null
      : loaded?.key === conv.activeId
        ? loaded
        : null;

  /**
   * Settings coerced to what the selected model can actually serve — a
   * thread saved against a reasoning model must not keep sending an effort
   * the current model would silently drop. Derived on read so switching
   * models can't leave stale knobs behind.
   */
  const effective = useMemo(
    () => (models.length > 0 ? reconcileSettings(settings, models) : settings),
    [settings, models],
  );

  /* ------------------------------ settings ----------------------------- */

  const changeSettings = useCallback(
    (patch: Partial<ChatSettings>) => {
      setSettings((s) => {
        const merged = { ...s, ...patch };
        const next =
          patch.model !== undefined ? reconcileSettings(merged, models) : merged;
        // Persist against the thread, so reopening it restores its knobs…
        if (conv.activeId) void conv.updateSettings(conv.activeId, next);
        // …and as the account default, so the *next* new chat inherits them
        // on this device and on every other one.
        account.updateSettings({
          defaults: {
            model: next.model,
            reasoning: next.reasoning,
            search: next.search,
          },
        });
        return next;
      });
    },
    [models, conv, account],
  );

  /* ------------------------------ actions ------------------------------ */

  const selectConversation = (id: string) => {
    setSidebarOpen(false);
    // Re-picking the open thread would retire the draft id and force a
    // pointless reload of a conversation already on screen.
    if (id === conv.activeId) return;
    // Retire the draft id so the guard above can't mistake a stored thread
    // for the live one and skip loading it.
    setDraftId(crypto.randomUUID());
    conv.setActiveId(id);
  };

  const newConversation = useCallback(() => {
    setDraftId(crypto.randomUUID());
    conv.setActiveId(null);
    // Carry model/reasoning/search forward; drop the thread-specific prompt.
    setSettings({ ...DEFAULT_SETTINGS, ...account.settings.defaults, system: "" });
    setSidebarOpen(false);
  }, [conv, account.settings.defaults]);

  /** Delete a thread and retire its live ChatView identity when it was open. */
  const removeConversation = useCallback(
    async (id: string) => {
      const wasActive = conv.activeId === id;
      await conv.remove(id);
      if (!wasActive) return;
      // The first saved thread shares the draft id it started with. Minting a
      // new one forces useChat to unmount, otherwise its in-memory transcript
      // can remain visible after the IndexedDB rows are gone.
      setDraftId(crypto.randomUUID());
      setSettings({ ...DEFAULT_SETTINGS, ...account.settings.defaults, system: "" });
    },
    [conv, account.settings.defaults],
  );

  /** Fork a thread into a fresh conversation carrying its history forward. */
  const branch = useCallback(
    async (messages: DialMessage[], from: ChatSettings) => {
      const id = crypto.randomUUID();
      await conv.saveTurn({ id, settings: from, messages, naming: false });
      const meta = await conv.getMeta(id);
      if (meta) await conv.rename(id, `${meta.title} ↳`);
      setDraftId(crypto.randomUUID());
      conv.setActiveId(id);
    },
    [conv],
  );

  const exportById = useCallback(
    async (id: string, format: "md" | "json" = "md") => {
      const meta = await conv.getMeta(id);
      if (!meta) return;
      const messages = await conv.loadMessages(id);
      exportConversation(meta, messages, format);
    },
    [conv],
  );

  /* ------------------------------ palette ------------------------------ */

  const commands = useMemo<Command[]>(() => {
    const active = conv.activeId;
    const list: Command[] = [
      { id: "new", label: "New conversation", hint: "⌘⇧K", run: newConversation },
    ];
    if (active) {
      const meta = conv.conversations.find((c) => c.id === active);
      list.push(
        {
          id: "export-md",
          label: "Export conversation as Markdown",
          run: () => void exportById(active, "md"),
        },
        {
          id: "export-json",
          label: "Export conversation as JSON",
          run: () => void exportById(active, "json"),
        },
        {
          id: "pin",
          label: meta?.pinned ? "Unpin conversation" : "Pin conversation",
          run: () => void conv.togglePin(active),
        },
        {
          id: "delete",
          label: "Delete conversation",
          hint: "no undo",
          run: () => void removeConversation(active),
        },
      );
    }
    list.push({
      id: "theme",
      label: "Toggle light / dark theme",
      run: () => document.dispatchEvent(new CustomEvent("dial:toggle-theme")),
    });
    // The token vault is intentionally not offered right now. Its endpoints
    // were replaced by account-authenticated ones when auth landed, so the
    // panel would fail on every action. Exposing a control that cannot work
    // is worse than not having one; it comes back with the account UI.
    list.push({
      id: "settings",
      label: "Account and settings",
      hint: account.user ? account.user.email : "not signed in",
      run: () => setSettingsOpen(true),
    });
    if (credential) {
      list.push({
        id: "disconnect",
        label: "Disconnect OpenRouter key",
        hint: keyFingerprint(credential.key),
        run: () => account.updateSettings({ openrouterKey: null }),
      });
    }
    return list;
  }, [
    conv,
    newConversation,
    exportById,
    removeConversation,
    credential,
    account,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (e.shiftKey) newConversation();
        else setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newConversation]);

  useEffect(() => {
    if (!settingsOpen && !authOpen) return;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (authOpen) setAuthOpen(false);
      else setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [settingsOpen, authOpen]);

  // The tab says which conversation it holds — useful with several open.
  const activeTitle = conv.conversations.find((c) => c.id === conv.activeId)?.title;
  useEffect(() => {
    document.title = activeTitle ? `${activeTitle} · Chat` : "Chat";
  }, [activeTitle]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  /* ------------------------------- render ------------------------------ */

  /*
   * The front door, in order of precedence.
   *
   * This used to be a single ternary on the OpenRouter key, because the app
   * was fully usable signed out — Dexie held everything and the cloud was
   * optional. There is no local store to fall back on now, so an
   * unauthenticated visitor has no app to show: every gate below has to be
   * passed before there is anything to render, and each one is the whole
   * page rather than a card inside an empty shell.
   *
   * `account.ready` leads deliberately. Without it a returning user with a
   * valid thirty-day session cookie sees a flash of the sign-in form while
   * the session resolves.
   */
  if (!account.ready) {
    return (
      <FrontDoor>
        <Loader timer={false} className="opacity-80" />
      </FrontDoor>
    );
  }

  if (!account.user) {
    return (
      <FrontDoor onTheme={(theme) => account.updateSettings({ theme })}>
        <AuthPanel
          onSignIn={account.signIn}
          onSignUp={account.signUp}
          onVerifyEmail={account.verifyEmail}
          onResendEmail={account.resendEmail}
        />
      </FrontDoor>
    );
  }

  const signedInAs = (
    <span>
      {account.user.email} ·{" "}
      <button
        type="button"
        onClick={() => void account.signOut()}
        className="transition-colors hover:text-foreground"
      >
        <span className="dial-underline">Sign out</span>
      </button>
    </span>
  );

  if (account.locked) {
    /* Signed in, but this device cannot read the account. An empty
       transcript would read as lost data; it is ciphertext waiting on a
       password. The theme is not persisted from here: the settings this
       device holds are placeholders until the real ones can be opened. */
    return (
      <FrontDoor footer={signedInAs}>
        <UnlockBar
          email={account.user.email}
          rememberDeviceKey={account.settings.rememberDeviceKey}
          onUnlock={account.unlock}
        />
      </FrontDoor>
    );
  }

  if (!credential) {
    return (
      <FrontDoor
        footer={signedInAs}
        onTheme={(theme) => account.updateSettings({ theme })}
      >
        <KeyGate
          signedIn
          encrypted={account.encrypted}
          onConnect={(next) =>
            account.updateSettings({ openrouterKey: next.key })
          }
        />
      </FrontDoor>
    );
  }

  const activeMeta = conv.conversations.find((c) => c.id === conv.activeId);

  const sidebar = (
    <ConversationList
      conversations={conv.conversations}
      activeId={conv.activeId}
      onSelect={selectConversation}
      onNew={newConversation}
      onRename={(id, t) => void conv.rename(id, t)}
      onDelete={(id) => void removeConversation(id)}
      onTogglePin={(id) => void conv.togglePin(id)}
      onExport={(id) => void exportById(id, "md")}
      account={{
        user: account.user,
        status: account.status,
        onOpen: () => setSettingsOpen(true),
      }}
    />
  );

  return (
    <div className="app-shell flex h-[100dvh] overflow-hidden">
      {/* Width comes from --dial-rail-w (restored pre-paint by the boot
          script, updated directly by RailHandle) so dragging never re-renders
          the tree. `.dial-rail` is what the collapsed class hides. The rail
          has no card of its own: it sits on the page, and the chat window is
          the one lifted surface. */}
      <div
        className="dial-rail relative hidden h-full shrink-0 overflow-hidden md:block"
        style={{ width: "var(--dial-rail-w)" }}
      >
        <div className="h-full py-2 pl-2">{sidebar}</div>
        <RailHandle
          onCommit={(railWidth) => account.updateSettings({ railWidth })}
        />
      </div>

      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            key="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Conversations"
            className="fixed inset-0 z-50 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
              onClick={() => setSidebarOpen(false)}
            />
            <motion.div
              className="absolute inset-y-0 left-0 w-[300px] max-w-[86vw] rounded-r-window bg-chrome py-2 pl-2 shadow-overlay"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }}
            >
              {sidebar}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="app-workspace relative m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-window bg-background max-md:m-0 max-md:rounded-none max-md:shadow-none">
        <StatusStrip
          title={activeMeta?.title}
          model={effective.model}
          ready={conv.ready}
          apiKey={credential?.key ?? null}
          threadCostUsd={activeMeta?.totalCostUsd}
          threadTokens={activeMeta?.totalTokens}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNewChat={newConversation}
          onRailCollapse={(railCollapsed) =>
            account.updateSettings({ railCollapsed })
          }
          onTheme={(theme) => account.updateSettings({ theme })}
        />

        {view ? (
          <ChatView
            key={view.key}
            conversationId={view.key}
            settings={effective}
            onSettingsChange={changeSettings}
            initialMessages={view.messages}
            models={models}
            userName={account.user.name}
            onOpenSwitcher={() => setPaletteOpen(true)}
            onBranch={(messages, from) => void branch(messages, from)}
            saveTurn={conv.saveTurn}
            loadMessages={conv.loadMessages}
            remoteVersion={account.pulled}
            setActiveId={conv.setActiveId}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Loader timer={false} className="opacity-70" />
          </div>
        )}

        {settingsOpen && (
          <SettingsPanel
            user={account.user}
            settings={account.settings}
            status={account.status}
            encrypted={account.encrypted}
            deviceKeyStored={account.deviceKeyStored}
            onUpdate={account.updateSettings}
            onSignOut={account.signOut}
            onDestroy={account.destroy}
            onSync={account.sync}
            usage={account.usage}
            onRefreshUsage={account.refreshUsage}
            onClose={() => setSettingsOpen(false)}
            onSignInRequested={() => {
              setSettingsOpen(false);
              setAuthOpen(true);
            }}
          />
        )}

        {paletteOpen && (
          <Palette
            models={models}
            current={effective.model}
            commands={commands}
            recentModels={account.settings.recentModels}
            onRecent={(recentModels) => account.updateSettings({ recentModels })}
            onSelect={(model) => {
              changeSettings({ model });
              setPaletteOpen(false);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
