"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  forgetKey,
  getSession,
  recallKey,
  signIn as apiSignIn,
  signInWithGoogle as apiGoogle,
  signOut as apiSignOut,
  signUp as apiSignUp,
  resendEmailOTP as apiResendEmailOTP,
  verifyEmailOTP as apiVerifyEmailOTP,
  type SessionUser,
} from "./auth-client";
import { localCredentialStore } from "./credentials";
import {
  applyAppearance,
  clearLocal,
  fetchRemote,
  pushRemote,
  readLocal,
  writeLocal,
  type UserSettings,
} from "./settings";
import {
  clearCursor,
  clearLocalData,
  deleteAccount,
  runSync,
  setLiveConnectionId,
} from "./sync";
import { deriveCredential } from "./auth-client";

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

/** Wait this long after the last change before writing to the cloud. */
const DEBOUNCE_MS = 1500;

export type SyncStatus =
  | { state: "offline" }
  | { state: "idle"; at: number | null }
  | { state: "syncing" }
  | { state: "error"; message: string };

export function useAccount(changeSignal: unknown) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<UserSettings>(readLocal);
  const [status, setStatus] = useState<SyncStatus>({ state: "offline" });
  /** False until the session has been resolved, so nothing flashes. */
  const [ready, setReady] = useState(false);
  /**
   * Whether this account has a vault key. Mirrored into state rather than
   * read off `kekRef` at render time — a ref read during render is a React
   * 19 lint error, and the value has to drive what the settings panel says
   * about where the user's chats can be read.
   */
  const [encrypted, setEncrypted] = useState(false);
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
   * The shell watches this to re-read the open thread. A pull writes into
   * Dexie behind React's back, so without a signal the rail refreshed and
   * the transcript in front of you did not — which is what made cross-device
   * sync look broken while it was in fact working.
   */
  const [pulled, setPulled] = useState(0);

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

  useEffect(() => {
    userRef.current = user;
    settingsRef.current = settings;
    lockedRef.current = locked;
    encryptedRef.current = encrypted;
  });

  /* ------------------------------ appearance ---------------------------- */

  useEffect(() => {
    applyAppearance(settings);
  }, [settings]);

  /* --------------------------------- sync ------------------------------- */

  const sync = useCallback(async () => {
    const current = userRef.current;
    if (!current || lockedRef.current) return;
    if (runningRef.current) {
      pendingSyncRef.current = true;
      return;
    }
    runningRef.current = true;
    setStatus({ state: "syncing" });
    try {
      const outcome = await runSync({
        userId: current.id,
        dek: kekRef.current,
        encrypted: encryptedRef.current,
      });
      if (outcome.pulled > 0) setPulled((count) => count + 1);
      setStatus({ state: "idle", at: Date.now() });
    } catch (error) {
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : "sync failed",
      });
    } finally {
      runningRef.current = false;
      if (pendingSyncRef.current) {
        pendingSyncRef.current = false;
        queueMicrotask(() => void syncRef.current());
      }
    }
  }, []);

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  /* ------------------------- adopt a signed-in user --------------------- */

  const adopt = useCallback(
    async (next: SessionUser, kek: CryptoKey | null) => {
      userRef.current = next;
      kekRef.current = kek;
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

        if (accountEncrypted && !kek) {
          setLocked(true);
          lockedRef.current = true;
          setStatus({ state: "error", message: "locked on this device" });
          return;
        }
        setLocked(false);
        lockedRef.current = false;

        if (remote.settings) {
          setSettings(remote.settings);
          writeLocal(remote.settings);
          settingsRef.current = remote.settings;
          if (remote.settings.openrouterKey) {
            localCredentialStore.write({
              key: remote.settings.openrouterKey,
              source: "manual",
              label: null,
              connectedAt: Date.now(),
            });
          }
        } else {
          // Nothing stored yet: this device's configuration becomes the
          // account's. Mirror it locally too, so the next load paints the
          // right theme without waiting for a round trip.
          await pushRemote(settingsRef.current, kek, accountEncrypted);
          writeLocal(settingsRef.current);
        }
      } catch {
        // Settings are a convenience; failing to reach them must not stop
        // someone from using the app they just signed in to.
      }

      await sync();
    },
    [sync],
  );

  /* ------------------------- restore on first load ---------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const existing = await getSession();
      if (cancelled) return;
      if (!existing) {
        setReady(true);
        return;
      }
      const kek = await recallKey();
      if (cancelled) return;
      await adopt(existing, kek);
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  /* ---------------------------- sync triggers --------------------------- */

  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => void sync(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [user, changeSignal, sync]);

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

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // Identifies this socket so the hub can skip it when fanning out a
      // revision this device just pushed. Minted per connection: a
      // reconnected socket is a different subscriber to the hub.
      const connection = crypto.randomUUID().replace(/-/g, "");
      socket = new WebSocket(
        `${protocol}//${window.location.host}/v1/live?c=${connection}`,
      );
      socket.onopen = () => {
        retry = 0;
        setLiveConnectionId(connection);
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { rev?: unknown };
          if (typeof payload.rev === "number") void sync();
        } catch {
          // Forward compatibility: unknown hub messages are ignored.
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        socket = null;
        setLiveConnectionId(null);
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
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      document.removeEventListener("visibilitychange", reconnect);
      socket?.close(1000, "session changed");
    };
  }, [user, locked, sync]);

  /* -------------------------------- actions ----------------------------- */

  const updateSettings = useCallback((patch: Partial<UserSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      settingsRef.current = next;
      writeLocal(next);

      // The OpenRouter key is read by the chat transport through the
      // credential store, so a change here has to reach it immediately —
      // not after the next reload.
      if (patch.openrouterKey !== undefined) {
        if (patch.openrouterKey) {
          localCredentialStore.write({
            key: patch.openrouterKey,
            source: "manual",
            label: null,
            connectedAt: Date.now(),
          });
        } else {
          localCredentialStore.clear();
        }
      }

      if (userRef.current) {
        pushChainRef.current = pushChainRef.current
          .then(() =>
            pushRemote(
              // Read the ref, not `next`: by the time this link of the chain
              // runs, a later change may already have superseded it.
              settingsRef.current,
              kekRef.current,
              encryptedRef.current,
            ),
          )
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
      const remote = await fetchRemote(kek);
      if (!remote.settings && remote.encryption !== "none") {
        throw new Error("that password does not unlock this account");
      }

      kekRef.current = kek;
      setLocked(false);
      lockedRef.current = false;

      // Start the next pull from zero.
      //
      // A device that regained its key does not know what it missed while it
      // did not have one, and an older build could advance the cursor past
      // records it failed to decrypt — leaving them on the server, above no
      // revision this device will ever ask for again. Re-reading everything
      // is cheap (records upsert by id) and it is the only thing that heals
      // a cursor that has already moved too far.
      clearCursor();
      if (remote.settings) {
        setSettings(remote.settings);
        writeLocal(remote.settings);
        settingsRef.current = remote.settings;
        if (remote.settings.openrouterKey) {
          localCredentialStore.write({
            key: remote.settings.openrouterKey,
            source: "manual",
            label: null,
            connectedAt: Date.now(),
          });
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
      const next = await getSession();
      if (!next) return { verificationRequired: true };
      await adopt(next, credential.kek);
      return { verificationRequired: false };
    },
    [adopt],
  );

  const verifyEmail = useCallback(
    async (email: string, otp: string) => {
      await apiVerifyEmailOTP(email, otp);
      const next = await getSession();
      if (!next) throw new Error("verified, but no session was returned");
      const key = await recallKey();
      if (!key) throw new Error("verified, but this device lost its vault key");
      await adopt(next, key);
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

  const signOut = useCallback(
    async (wipeDevice: boolean) => {
      await apiSignOut();
      // Local conversations are a cache of the account. Leaving them on a
      // shared machine after someone signs out would be a real leak, so the
      // default is to clear them; the cloud copy is the durable one.
      if (wipeDevice) {
        await clearLocalData();
        localCredentialStore.clear();
        clearLocal();
      }
      clearCursor();
      await forgetKey();
      userRef.current = null;
      kekRef.current = null;
      setUser(null);
      setEncrypted(false);
      setLocked(false);
      lockedRef.current = false;
      setStatus({ state: "offline" });
    },
    [],
  );

  const destroy = useCallback(async () => {
    await deleteAccount();
    await clearLocalData();
    localCredentialStore.clear();
    clearLocal();
    clearCursor();
    await forgetKey();
    userRef.current = null;
    kekRef.current = null;
    setUser(null);
    setEncrypted(false);
    setSettings(readLocal());
    setStatus({ state: "offline" });
  }, []);

  return {
    user,
    ready,
    settings,
    status,
    /** True when this account's records are end-to-end encrypted. */
    encrypted,
    /** Signed in but missing the key — the UI must ask for the password. */
    locked,
    unlock,
    updateSettings,
    /** Increments when a sync applied remote records. */
    pulled,
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
