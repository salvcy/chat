"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ChatView from "@/components/chat/ChatView";
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
import { db, settingsOf } from "@/lib/db";
import { exportConversation } from "@/lib/export";
import { newConversationSettings, writeDefaults } from "@/lib/preferences";
import { useAccount } from "@/lib/session";
import type { ChatSettings, OpenRouterModel } from "@/lib/types";

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
  const conv = useConversations();
  const { credential, disconnect } = useCredential();
  /**
   * The signed-in account. `conv.localWrites` is the change signal — it
   * counts local mutations only, so a pull writing rows cannot feed back and
   * schedule another sync forever.
   */
  const account = useAccount(conv.localWrites);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  // Session defaults (model + reasoning + search) rather than hard defaults:
  // a new chat inherits the knobs you were last working with.
  const [settings, setSettings] = useState<ChatSettings>(newConversationSettings);
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
  /** Messages for the active thread, once read out of Dexie. */
  const [loaded, setLoaded] = useState<{
    key: string;
    messages: DialMessage[];
  } | null>(null);

  /**
   * A pull writes into Dexie behind React's back, so the rail has to re-read
   * once a sync settles — otherwise a conversation created on another device
   * exists locally but never appears.
   */
  const syncState = account.status.state;
  useEffect(() => {
    if (syncState !== "idle") return;
    void conv.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is stable; re-run only when a sync settles
  }, [syncState, account.status]);

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
    // so re-reading it here would overwrite a streaming thread with Dexie.
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
        // …and as the session default, so the *next* new chat inherits them.
        writeDefaults(next);
        return next;
      });
    },
    [models, conv],
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
    setSettings(newConversationSettings());
    setSidebarOpen(false);
  }, [conv]);

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
      setSettings(newConversationSettings());
    },
    [conv],
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
      const meta = await db.conversations.get(id);
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
        run: () => {
          disconnect();
          account.updateSettings({ openrouterKey: null });
        },
      });
    }
    return list;
  }, [
    conv,
    newConversation,
    exportById,
    removeConversation,
    credential,
    disconnect,
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
          the tree. `.dial-rail` is what the collapsed class hides. */}
      <div
        className="dial-rail relative hidden h-full shrink-0 overflow-hidden md:block"
        style={{ width: "var(--dial-rail-w)" }}
      >
        <div className="h-full p-2 pr-0">{sidebar}</div>
        <RailHandle />
      </div>

      {sidebarOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Conversations"
          className="fixed inset-0 z-50 bg-chrome/70 backdrop-blur-md md:hidden"
          onClick={() => setSidebarOpen(false)}
        >
          <div
            className="h-full w-72 max-w-[86vw] p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {sidebar}
          </div>
          <button
            type="button"
            aria-label="Close conversations"
            onClick={() => setSidebarOpen(false)}
            className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border border-hairline bg-panel/80 text-lg text-muted backdrop-blur-xl transition-colors hover:text-foreground"
          >
            ×
          </button>
        </div>
      )}

      <main className="app-workspace relative m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-hairline bg-background max-md:m-0 max-md:rounded-none max-md:border-0">
        <StatusStrip
          title={activeMeta?.title}
          model={effective.model}
          ready={conv.ready}
          apiKey={credential?.key ?? null}
          threadCostUsd={activeMeta?.totalCostUsd}
          threadTokens={activeMeta?.totalTokens}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSidebar={() => setSidebarOpen(true)}
        />

        {account.locked && account.user && (
          <UnlockBar email={account.user.email} onUnlock={account.unlock} />
        )}

        {conv.ready && !credential ? (
          <KeyGate
            signedIn={account.user !== null}
            encrypted={account.encrypted}
            onConnect={(next) =>
              account.updateSettings({ openrouterKey: next.key })
            }
          />
        ) : view ? (
          <ChatView
            key={view.key}
            conversationId={view.key}
            settings={effective}
            onSettingsChange={changeSettings}
            initialMessages={view.messages}
            models={models}
            onOpenSwitcher={() => setPaletteOpen(true)}
            onBranch={(messages, from) => void branch(messages, from)}
            saveTurn={conv.saveTurn}
            loadMessages={conv.loadMessages}
            remoteVersion={account.pulled}
            setActiveId={conv.setActiveId}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <span className="font-mono text-xs text-muted">…</span>
          </div>
        )}

        {settingsOpen && (
          <SettingsPanel
            user={account.user}
            settings={account.settings}
            status={account.status}
            encrypted={account.encrypted}
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

        {authOpen && (
          <AuthPanel
            onSignIn={account.signIn}
            onSignUp={account.signUp}
            onVerifyEmail={account.verifyEmail}
            onResendEmail={account.resendEmail}
            onClose={() => setAuthOpen(false)}
          />
        )}

        {paletteOpen && (
          <Palette
            models={models}
            current={effective.model}
            commands={commands}
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
