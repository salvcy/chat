"use client";

/**
 * Where the vault key lives between reloads.
 *
 * This is the only thing this app still keeps in the browser's own storage,
 * and it is here for a reason that has no alternative: the vault key is a
 * **non-extractable `CryptoKey`**, and IndexedDB is the only web storage that
 * can hold one. `localStorage` takes strings, so putting the key there would
 * mean exporting the raw bytes first — turning a key that script can *use*
 * but cannot *steal* into one it can copy out and post anywhere.
 *
 * The alternative was asking for the password on every page load. A session
 * cookie lasts thirty days; the key can only be derived from a password typed
 * once. Bridging that gap is the whole job of this file.
 *
 * So: no Dexie, no chat data — one object store holding at most one
 * non-extractable key per account used in this browser. The account id is the
 * record key, which prevents a stale key from one login ever being offered to
 * another account.
 *
 * Everything here swallows its errors. Private browsing, a storage quota, a
 * browser configured to refuse site data — each of those makes the key
 * unavailable rather than the app broken. The caller treats a missing key as
 * "locked", which is a state the UI already knows how to show.
 */

const DB_NAME = "dial-vault";
const STORE = "keys";
const LEGACY_RECORD = "session";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    // Another tab is holding an old version open. Failing is correct: the
    // caller falls back to locked rather than hanging on a promise that has
    // no timeout.
    request.onblocked = () => reject(new Error("vault store is blocked"));
  });
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = work(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
        transaction.onabort = () => {
          database.close();
          reject(transaction.error);
        };
      }),
  );
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

/** Persist the key for this account and browser. */
export async function rememberKey(
  accountId: string,
  key: CryptoKey,
): Promise<boolean> {
  try {
    await run("readwrite", (store) => store.put(key, accountId));
    // Clean up the unscoped record written by the first cloud-only build.
    await run("readwrite", (store) => store.delete(LEGACY_RECORD));
    return true;
  } catch {
    // Storage refused. Encryption still works for this session; the next
    // reload lands in the locked state and asks for the password.
    return false;
  }
}

export async function recallKey(accountId: string): Promise<CryptoKey | null> {
  try {
    const value = await run<unknown>("readonly", (store) => store.get(accountId));
    // Anything that is not a usable key is treated as absent — a half-written
    // record must read as "locked", never as a key that fails at first use.
    if (isCryptoKey(value)) return value;

    // One-time migration from the original unscoped record. `adopt` verifies
    // it against the encrypted settings before it can write anything.
    const legacy = await run<unknown>("readonly", (store) =>
      store.get(LEGACY_RECORD),
    );
    if (!isCryptoKey(legacy)) return null;
    await rememberKey(accountId, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export async function forgetKey(accountId: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(accountId));
    await run("readwrite", (store) => store.delete(LEGACY_RECORD));
  } catch {
    // Nothing to do.
  }
}

/**
 * Remove the databases the local-first build left behind.
 *
 * `dial` held every conversation and message this browser had ever seen.
 * Those rows are now on the server and the tables will never be read again,
 * so leaving them would mean a browser quietly retaining a full plaintext
 * copy of someone's chat history for as long as the profile lives — the
 * exact thing moving to a sealed cloud store was meant to stop.
 *
 * Best-effort and idempotent: it runs once per load, costs nothing when the
 * database is already gone, and a browser that refuses is no worse off than
 * before.
 */
export function discardLegacyStores(): void {
  if (typeof indexedDB === "undefined") return;
  try {
    indexedDB.deleteDatabase("dial");
  } catch {
    // Nothing to do.
  }
}
