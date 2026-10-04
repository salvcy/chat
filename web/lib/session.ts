"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSession,
  signIn as apiSignIn,
  signInWithGoogle as apiGoogle,
  signOut as apiSignOut,
  signUp as apiSignUp,
  resendEmailOTP as apiResendEmailOTP,
  verifyEmailOTP as apiVerifyEmailOTP,
  type SessionUser,
} from "./auth-client";
import { setCredential } from "./credentials";
import {
  discardLegacyStores,
  forgetKey,
  recallKey,
  rememberKey,
} from "./keystore";
import {
  applyAppearance,
  clearLocal,
  fetchRemote,
  fetchUsage,
  purgeLegacyLocal,
  pushRemote,
  readLocal,
  SettingsDecryptError,
  writeLocal,
  DEFAULT_SETTINGS,
  type AccountUsage,
  type UserSettings,
} from "./settings";
import {
  deleteAccount,
  forgetUploads,
  liveConnectionId,
  readDelta,
  setEncryption,
  setLiveConnectionId,
  setRevisionObserver,
  setVaultKey,
  type ConversationMeta,
} from "./store";
import { attachLiveSocket, dispatchLive, isLiveMessage, setLivePeers } from "./live";
import { deriveCredential } from "./auth-client";
import { OfflineError, forgetSession, openLiveSocket } from "./api";

/**
 * The signed-in account: who you are, what you've configured, and keeping
 * both in step with the cloud.
 *
 * Two ordering rules hold this together, and both exist because getting them
 * backwards produced visible bugs:
 *
 *  - **Appearance is applied from the local mirror before the network is
 *    consulted.** Waiting for `/v1/state` would mean a flash of the wrong
 *    theme on every load.
 *  - **Remote settings win, but only when they exist.** An encrypted blob we
 *    cannot open yet reads as absent, and treating absent as empty would
 *    overwrite a working configuration with defaults.
 */

/**
 * Settings that belong to the device that set them. They still travel with
 * the account — a reload restores them — but another device changing them is
 * no reason to rearrange this one: opening a thread on the phone must not
 * switch the laptop's, and a drawer's width means nothing to a desktop rail.
 */
const DEVICE_FIELDS = [
  "activeThread",
  "railWidth",
  "railCollapsed",
  "rememberDeviceKey",
] as const satisfies readonly (keyof UserSettings)[];

function changesShared(patch: Partial<UserSettings>): boolean {
  return Object.keys(patch).some(
    (field) => !(DEVICE_FIELDS as readonly string[]).includes(field),
  );
}

export type SyncStatus =
  | { state: "offline" }
  | { state: "idle"; at: number | null }
  | { state: "syncing" }
  | { state: "error"; message: string };

export type AccountOptions = {
  /**
   * The thread this device has open, as a ref rather than a value.
   *
   * The account and the conversation store need each other — a delta has to
   * know which thread to ask about, and the answer has to land back in the
   * sidebar — and a value would make that a cycle React cannot express. The
   * ref is read at delta time, which is also the only moment it matters. It
   * is the same reason `lib/transport.ts` takes the settings ref instead of
   * closing over the settings.
   */
  openThreadRef: { current: string | null };
  /** Fold changed threads into the sidebar. Must be stable. */
  onThreads?: (threads: ConversationMeta[], removed: string[]) => void;
};

export function useAccount({ openThreadRef, onThreads }: AccountOptions) {
  const [user, setUser] = useState<SessionUser | null>(null);
  /**
   * Appearance seeds from the local mirror; everything else waits for the
   * account. The mirror holds five enums and a rail width — it cannot supply
   * an OpenRouter key or a thread id, and must not pretend to.
   */
  const [settings, setSettings] = useState<UserSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...readLocal(),
  }));
  const [status, setStatus] = useState<SyncStatus>({ state: "offline" });
  /** False until the session has been resolved, so nothing flashes. */
  const [ready, setReady] = useState(false);
  /** True while the session cannot be resolved because the server is unreachable. */
  const [unreachable, setUnreachable] = useState(false);
  /**
   * Whether this account has a vault key. Mirrored into state rather than
   * read off `kekRef` at render time — a ref read during render is a React
   * 19 lint error, and the value has to drive what the settings panel says
   * about where the user's chats can be read.
   */
  const [encrypted, setEncrypted] = useState(false);
  /** Whether this account's non-extractable key is stored in this browser. */
  const [deviceKeyStored, setDeviceKeyStored] = useState(false);
  /**
   * Signed in, with an encrypted account, but without the key to read it.
   *
   * This happens more often than it sounds: the session cookie lasts thirty
   * days and is httpOnly, while the vault key lives in IndexedDB — so
   * clearing site data, or any browser cleanup that spares cookies, leaves
   * someone authenticated and unable to decrypt their own history. Syncing
   * in that state is worse than not syncing, so the app says so and asks for
   * the password instead.
   */
  const [locked, setLocked] = useState(false);
  /**
   * Bumped whenever a reconciliation actually applied remote records.
   *
   * The shell watches this to re-read the open thread. A delta patches the
   * rail, but useChat owns the transcript in memory; without a signal the
   * sidebar refreshed and the conversation in front of you did not.
   */
  const [pulled, setPulled] = useState(0);
  /** Storage totals, fetched on demand rather than kept live. */
  const [usage, setUsage] = useState<AccountUsage | null>(null);

  const userRef = useRef<SessionUser | null>(null);
  const kekRef = useRef<CryptoKey | null>(null);
  const settingsRef = useRef(settings);
  const lockedRef = useRef(false);
  const encryptedRef = useRef(false);
  /**
   * Serialises settings writes.
   *
   * Changing three preferences quickly fired three overlapping PUTs, and
   * nothing guaranteed they reached the server in the order they were made —
   * an earlier state could land last and silently undo the later two. Chaining
   * onto the previous request, and always sending the newest snapshot rather
   * than the one captured when the request was queued, makes the last change
   * the one that wins regardless of network timing.
   */
  const pushChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Stops two syncs overlapping and pushing the same rows twice. */
  const runningRef = useRef(false);
  /** A realtime invalidation that arrived while reconciliation was running. */
  const pendingSyncRef = useRef(false);
  const syncRef = useRef<() => Promise<void>>(async () => undefined);
  /** The account revision this device has already seen. Never persisted. */
  const revRef = useRef(0);
  const onThreadsRef = useRef(onThreads);
  /** A shared setting changed here and the next push should say so. */
  const notifyNextRef = useRef(false);
  /** Bumped by every local settings edit, so a remote read can tell it raced one. */
  const localEditsRef = useRef(0);
  const refreshSettingsRef = useRef<() => Promise<void>>(async () => undefined);
  /** Key derived during signup while an optional OTP gate is still pending. */
  const pendingSignupKeyRef = useRef<CryptoKey | null>(null);

  useEffect(() => {
    userRef.current = user;
    settingsRef.current = settings;
    lockedRef.current = locked;
    encryptedRef.current = encrypted;
    onThreadsRef.current = onThreads;
  });

  /* A local commit is already a revision this device has seen. */
  useEffect(() => {
    setRevisionObserver((revision) => {
      revRef.current = Math.max(revRef.current, revision);
    });
    return () => setRevisionObserver(null);
  }, []);

  /**
   * Clear what the local-first build left on this device.
   *
   * The `dial` IndexedDB database held every conversation this browser had
   * ever seen, and `dial:credential` held the OpenRouter key as plaintext.
   * Neither is read any more, so leaving them would mean quietly retaining a
   * full plaintext copy of someone's history and a billable credential for as
   * long as the profile lives.
   */
  useEffect(() => {
    purgeLegacyLocal();
    discardLegacyStores();
  }, []);

  /* ------------------------------ appearance ---------------------------- */

  useEffect(() => {
    applyAppearance(settings);
  }, [settings]);

  /* --------------------------------- sync ------------------------------- */

  /**
   * Ask what changed and fold it in.
   *
   * This replaces the pull-then-push reconciliation entirely. There is
   * nothing to push — a write went straight to the server when it happened —
   * so all that is left is discovering writes made *elsewhere*. That is one
   * request answering two questions: which thread rows moved, and did
   * anything inside the thread this device has open move.
   *
   * The revision cursor lives in a ref and is never persisted. The old one
   * was in `localStorage` and had to be exactly right or rows were skipped
   * for good; this one is a latency optimisation, and losing it costs a
   * single redundant delta.
   */
  const refresh = useCallback(async () => {
    const current = userRef.current;
    if (!current || lockedRef.current) return;
    if (runningRef.current) {
      pendingSyncRef.current = true;
      return;
    }
    runningRef.current = true;
    setStatus({ state: "syncing" });
    try {
      let threadChanged = false;
      // Page until the server says it is done: a full page ends at its last
      // row's revision, not the account's.
      for (let page = 0; page < 50; page++) {
        const since = revRef.current;
        const delta = await readDelta(since, openThreadRef.current);
        // A local commit can land while this read is in flight. Never let the
        // older response move the cursor backwards and make our own checkpoint
        // look like a remote edit on the next refresh.
        revRef.current = Math.max(revRef.current, delta.rev);
        if (delta.threads.length > 0 || delta.removed.length > 0) {
          onThreadsRef.current?.(delta.threads, delta.removed);
        }
        threadChanged ||= delta.threadChanged;
        if (!delta.hasMore || delta.rev <= since) break;
      }
      // ChatView watches this to re-read the open transcript. Bumping it for
      // every delta would make an unrelated thread's write re-read the one in
      // front of the reader, which is exactly the churn the scoped delta
      // exists to avoid.
      if (threadChanged) setPulled((count) => count + 1);
      setStatus({ state: "idle", at: Date.now() });
    } catch (error) {
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : "could not reach the account",
      });
    } finally {
      runningRef.current = false;
      if (pendingSyncRef.current) {
        pendingSyncRef.current = false;
        queueMicrotask(() => void syncRef.current());
      }
    }
  }, [openThreadRef]);
  const sync = refresh;

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  const refreshUsage = useCallback(async () => {
    if (!userRef.current) return;
    setUsage(await fetchUsage());
  }, []);

  /**
   * Another device changed a shared setting: read the blob again and take
   * everything but this device's own fields.
   *
   * This device's pending writes land first, and a local edit made while the
   * read was in flight wins — its own push is already on the way and will
   * notify the other device in turn.
   */
  const refreshSettings = useCallback(async () => {
    if (!userRef.current || lockedRef.current) return;
    const edits = localEditsRef.current;
    await pushChainRef.current;
    let remote;
    try {
      remote = await fetchRemote(kekRef.current);
    } catch {
      return;
    }
    if (!remote.settings || edits !== localEditsRef.current) return;

    const local = settingsRef.current;
    const next: UserSettings = { ...remote.settings };
    for (const field of DEVICE_FIELDS) {
      (next as Record<string, unknown>)[field] = local[field];
    }
    if (JSON.stringify(next) === JSON.stringify(local)) return;

    settingsRef.current = next;
    setSettings(next);
    writeLocal(next);
    if (next.openrouterKey !== local.openrouterKey) {
      setCredential(
        next.openrouterKey
          ? { key: next.openrouterKey, source: "manual", label: null, connectedAt: Date.now() }
          : null,
      );
    }
  }, []);

  useEffect(() => {
    refreshSettingsRef.current = refreshSettings;
  }, [refreshSettings]);

  /* ------------------------- adopt a signed-in user --------------------- */

  const adopt = useCallback(
    async (next: SessionUser, kek: CryptoKey | null) => {
      userRef.current = next;
      kekRef.current = kek;
      setVaultKey(kek);
      setUser(next);

      // Remote settings are authoritative when readable. When they are not —
      // no blob yet, or ciphertext without a key — the local mirror stands
      // and gets pushed up, which is what makes the first sign-in on a fresh
      // account carry this device's configuration with it.
      try {
        const remote = await fetchRemote(kek);

        // The server is the authority on whether this account is encrypted.
        // Trusting the presence of a local key instead would call a locked
        // device "not encrypted" and then happily overwrite the account's
        // ciphertext with plaintext.
        const accountEncrypted = remote.encryption !== "none";
        setEncrypted(accountEncrypted);
        encryptedRef.current = accountEncrypted;
        setEncryption(remote.encryption);
        // Everything this device has seen. Deltas start from here, so a
        // reload asks for what changed rather than for the whole account.
        revRef.current = remote.rev;

        if (accountEncrypted && !kek) {
          setDeviceKeyStored(false);
          setLocked(true);
          lockedRef.current = true;
          setStatus({ state: "error", message: "locked on this device" });
          return;
        }
        setLocked(false);
        lockedRef.current = false;

        const adoptedSettings = remote.settings ?? settingsRef.current;
        if (remote.settings) {
          setSettings(adoptedSettings);
          writeLocal(adoptedSettings);
          settingsRef.current = adoptedSettings;
          setCredential(
            adoptedSettings.openrouterKey
              ? {
                  key: adoptedSettings.openrouterKey,
                  source: "manual",
                  label: null,
                  connectedAt: Date.now(),
                }
              : null,
          );
        } else {
          // Nothing stored yet: this device's configuration becomes the
          // account's. Mirror it locally too, so the next load paints the
          // right theme without waiting for a round trip.
          await pushRemote(settingsRef.current, kek, accountEncrypted);
          writeLocal(settingsRef.current);
        }

        if (kek) {
          if (adoptedSettings.rememberDeviceKey) {
            setDeviceKeyStored(await rememberKey(next.id, kek));
          } else {
            await forgetKey(next.id);
            setDeviceKeyStored(false);
          }
        }
      } catch (error) {
        if (error instanceof SettingsDecryptError) {
          // Never let an old, unscoped key write. Remove it and return to the
          // explicit unlock state, where the password verifies itself by
          // opening the account's settings before any write is possible.
          await forgetKey(next.id);
          kekRef.current = null;
          setVaultKey(null);
          setEncryption(error.encryption);
          setEncrypted(true);
          encryptedRef.current = true;
          setDeviceKeyStored(false);
          setLocked(true);
          lockedRef.current = true;
          setStatus({ state: "error", message: "locked on this device" });
          return;
        }
        // Settings are a convenience; failing to reach them must not stop
        // someone from using the app they just signed in to.
        if (kek && settingsRef.current.rememberDeviceKey) {
          setDeviceKeyStored(await rememberKey(next.id, kek));
        }
      }

      await sync();
    },
    [sync],
  );

  /* ------------------------- restore on first load ---------------------- */

  useEffect(() => {
    let cancelled = false;
    let wake: (() => void) | null = null;
    const retryNow = () => wake?.();
    window.addEventListener("online", retryNow);

    /*
     * Keep asking until the server answers. "Unreachable" is not "signed
     * out": answering it with the sign-in form tells a returning user their
     * session is gone when only the network is. The desktop app opens with
     * no network at all, which a web page never could.
     */
    const resolve = async (): Promise<SessionUser | null | undefined> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const session = await getSession();
          setUnreachable(false);
          return session;
        } catch (error) {
          if (!(error instanceof OfflineError)) return null;
        }
        if (cancelled) return undefined;
        setUnreachable(true);
        await new Promise<void>((done) => {
          const timer = setTimeout(done, Math.min(30_000, 1000 * 2 ** attempt));
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
        wake = null;
        if (cancelled) return undefined;
      }
    };

    void (async () => {
      const existing = await resolve();
      if (cancelled || existing === undefined) return;
      if (!existing) {
        setReady(true);
        return;
      }
      const kek = await recallKey(existing.id);
      if (cancelled) return;
      setDeviceKeyStored(kek !== null);
      await adopt(existing, kek);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("online", retryNow);
      retryNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  /* ---------------------------- sync triggers --------------------------- */

  /*
   * There is deliberately no "something changed locally, schedule a sync"
   * effect any more.
   *
   * That debounce existed because a local write only reached D1 when the
   * engine got round to pushing it. A write is a request now, so by the time
   * anything could observe the change it is already durable — scheduling a
   * reconciliation on top of it would spend a request to be told nothing
   * happened. What is left is discovering writes made elsewhere, which is
   * what the socket and the focus handler below are for.
   */

  useEffect(() => {
    if (!user) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [user, sync]);

  /**
   * Cross-device realtime sync.
   *
   * The socket carries revision numbers only. On each invalidation this
   * device runs the same authenticated encrypted pull it would run on focus,
   * so WebSocket delivery is an optimisation rather than a second source of
   * truth. Cloudflare can hibernate its per-user Durable Object while idle.
   */
  useEffect(() => {
    if (!user || locked) return;

    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket | null = null;

    const schedule = () => {
      if (stopped || timer !== null) return;
      const delay = Math.min(30_000, 750 * 2 ** retry);
      retry = Math.min(retry + 1, 6);
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay + Math.random() * 300);
    };

    const connect = () => {
      if (
        stopped ||
        document.visibilityState !== "visible" ||
        navigator.onLine === false ||
        socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING
      ) {
        return;
      }

      // Identifies this socket so the hub can skip it when fanning out a
      // revision this device just pushed. Minted per connection: a
      // reconnected socket is a different subscriber to the hub.
      const connection = crypto.randomUUID().replace(/-/g, "");
      socket = openLiveSocket(`c=${connection}`);
      const opened = socket;
      opened.onopen = () => {
        retry = 0;
        setLiveConnectionId(connection);
        attachLiveSocket(opened);
      };
      opened.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            t?: unknown;
            n?: unknown;
            rev?: unknown;
            thread?: unknown;
            settings?: unknown;
          };
          if (payload.t === "peers" && typeof payload.n === "number") {
            setLivePeers(payload.n);
            return;
          }
          // Another device's live stream, or a request for this one's.
          if (isLiveMessage(payload)) {
            dispatchLive(payload);
            return;
          }
          if (payload.settings === true) void refreshSettingsRef.current();
          // A revision we already hold is the hub catching a device up on
          // connect, or a duplicate fan-out. Either way there is nothing to
          // ask for, and asking anyway would spend a request to be told so.
          if (typeof payload.rev !== "number") return;
          if (payload.rev <= revRef.current) return;
          void sync();
        } catch {
          // Forward compatibility: unknown hub messages are ignored.
        }
      };
      opened.onerror = () => opened.close();
      opened.onclose = () => {
        if (socket === opened) socket = null;
        setLiveConnectionId(null);
        attachLiveSocket(null);
        schedule();
      };
    };

    const reconnect = () => {
      if (document.visibilityState !== "visible") return;
      if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    };

    connect();
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      stopped = true;
      setLiveConnectionId(null);
      attachLiveSocket(null);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      socket?.close(1000, "session changed");
    };
  }, [user, locked, sync]);

  /* -------------------------------- actions ----------------------------- */

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    if (patch.rememberDeviceKey !== undefined) {
      const current = userRef.current;
      const key = kekRef.current;
      if (patch.rememberDeviceKey && current && key) {
        void rememberKey(current.id, key).then(setDeviceKeyStored);
      } else if (current) {
        void forgetKey(current.id).then(() => setDeviceKeyStored(false));
      }
    }

    localEditsRef.current += 1;
    if (changesShared(patch)) notifyNextRef.current = true;

    setSettings((current) => {
      const next = { ...current, ...patch };
      settingsRef.current = next;
      writeLocal(next);

      // The OpenRouter key is read by the chat transport through the
      // credential store, so a change here has to reach it immediately —
      // not after the next reload.
      if (patch.openrouterKey !== undefined) {
        setCredential(
          patch.openrouterKey
            ? {
                key: patch.openrouterKey,
                source: "manual",
                label: null,
                connectedAt: Date.now(),
              }
            : null,
        );
      }

      if (userRef.current) {
        pushChainRef.current = pushChainRef.current
          .then(() => {
            const notify = notifyNextRef.current;
            notifyNextRef.current = false;
            return pushRemote(
              // Read the ref, not `next`: by the time this link of the chain
              // runs, a later change may already have superseded it.
              settingsRef.current,
              kekRef.current,
              encryptedRef.current,
              { client: liveConnectionId(), notify },
            );
          })
          .catch(() => {
            // Kept locally; the next successful save carries it up.
          });
      }
      return next;
    });
  }, []);

  /**
   * Re-derive the vault key from the password, for a device that is signed
   * in but locked. No network round trip for auth — the session is already
   * valid; this only recovers the key that decrypts what is already there.
   */
  const unlock = useCallback(
    async (password: string) => {
      const current = userRef.current;
      if (!current) throw new Error("not signed in");
      const { kek } = await deriveCredential(current.email, password);

      // Verify by trying to actually read something with it. Accepting a
      // wrong password here would leave the app looking unlocked while every
      // record silently failed to decrypt.
      let remote;
      try {
        remote = await fetchRemote(kek);
      } catch (error) {
        if (error instanceof SettingsDecryptError) {
          throw new Error("that password does not unlock this account");
        }
        throw error;
      }
      if (!remote.settings && remote.encryption !== "none") {
        throw new Error("that password does not unlock this account");
      }

      kekRef.current = kek;
      setLocked(false);
      lockedRef.current = false;
      setEncrypted(remote.encryption !== "none");
      encryptedRef.current = remote.encryption !== "none";
      setEncryption(remote.encryption);

      // The state read includes the account's current revision. The full
      // thread list that mounts after unlock is the authoritative repair;
      // starting deltas here avoids replaying this account's entire history.
      revRef.current = remote.rev;
      setVaultKey(kek);
      if (remote.settings) {
        setSettings(remote.settings);
        writeLocal(remote.settings);
        settingsRef.current = remote.settings;
        setCredential(
          remote.settings.openrouterKey
            ? {
                key: remote.settings.openrouterKey,
                source: "manual",
                label: null,
                connectedAt: Date.now(),
              }
            : null,
        );

        if (remote.settings.rememberDeviceKey) {
          setDeviceKeyStored(await rememberKey(current.id, kek));
        } else {
          await forgetKey(current.id);
          setDeviceKeyStored(false);
        }
      }
      await sync();
    },
    [sync],
  );

  const signUp = useCallback(
    async (input: {
      email: string;
      password: string;
      name: string;
      dateOfBirth: string;
    }) => {
      const credential = await apiSignUp(input);
      pendingSignupKeyRef.current = credential.kek;
      const next = await getSession();
      if (!next) return { verificationRequired: true };
      await adopt(next, credential.kek);
      pendingSignupKeyRef.current = null;
      return { verificationRequired: false };
    },
    [adopt],
  );

  const verifyEmail = useCallback(
    async (email: string, otp: string) => {
      await apiVerifyEmailOTP(email, otp);
      const next = await getSession();
      if (!next) throw new Error("verified, but no session was returned");
      const key = pendingSignupKeyRef.current ?? (await recallKey(next.id));
      if (!key) throw new Error("verified, but this device lost its vault key");
      await adopt(next, key);
      pendingSignupKeyRef.current = null;
    },
    [adopt],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const credential = await apiSignIn(email, password);
      const next = await getSession();
      if (!next) throw new Error("signed in but no session was returned");
      await adopt(next, credential.kek);
    },
    [adopt],
  );

  const signOut = useCallback(async () => {
    const accountId = userRef.current?.id;
    try {
      await apiSignOut();
    } finally {
      // There is no local conversation copy any more. Signing out removes the
      // device key and the small preference mirror; the cloud account remains
      // the only copy of the history.
      clearLocal();
      forgetUploads();
      setCredential(null);
      setVaultKey(null);
      setEncryption("none");
      revRef.current = 0;
      if (accountId) await forgetKey(accountId);
      userRef.current = null;
      kekRef.current = null;
      pendingSignupKeyRef.current = null;
      setUser(null);
      setEncrypted(false);
      setDeviceKeyStored(false);
      setLocked(false);
      lockedRef.current = false;
      setStatus({ state: "offline" });
    }
  }, []);

  const destroy = useCallback(async () => {
    const accountId = userRef.current?.id;
    await deleteAccount();
    await forgetSession();
    forgetUploads();
    setCredential(null);
    setVaultKey(null);
    setEncryption("none");
    clearLocal();
    revRef.current = 0;
    if (accountId) await forgetKey(accountId);
    userRef.current = null;
    kekRef.current = null;
    pendingSignupKeyRef.current = null;
    setUser(null);
    setEncrypted(false);
    setDeviceKeyStored(false);
    setSettings({ ...DEFAULT_SETTINGS, ...readLocal() });
    setStatus({ state: "offline" });
  }, []);

  return {
    user,
    ready,
    /** The session could not be resolved yet because the server is unreachable. */
    unreachable,
    settings,
    status,
    /** True when this account's records are end-to-end encrypted. */
    encrypted,
    /** True when this browser actually retained the non-extractable key. */
    deviceKeyStored,
    /** Signed in but missing the key — the UI must ask for the password. */
    locked,
    unlock,
    updateSettings,
    /** Increments when a sync applied remote records. */
    pulled,
    usage,
    refreshUsage,
    signUp,
    verifyEmail,
    resendEmail: apiResendEmailOTP,
    signIn,
    signInWithGoogle: apiGoogle,
    signOut,
    destroy,
    sync,
  };
}
