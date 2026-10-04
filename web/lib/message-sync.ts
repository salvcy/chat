/**
 * Re-attach already-uploaded R2 references without reusing stale message
 * content.
 *
 * A streaming assistant message keeps the same id while its text and
 * reasoning parts grow. The old upload memo cached the entire `parts` array
 * under that id, so the first checkpoint's partial text was sealed again for
 * every later checkpoint and even the final save. Only heavyweight blob
 * references are reusable; every other field must come from the current
 * snapshot.
 */
export function reuseUploadedBlobReferences<T extends { type: string }>(
  current: readonly T[],
  cached: readonly T[],
): T[] {
  const seen = new Map<string, number>();
  const cachedByType = new Map<string, T[]>();
  for (const part of cached) {
    const group = cachedByType.get(part.type) ?? [];
    group.push(part);
    cachedByType.set(part.type, group);
  }

  return current.map((raw) => {
    const occurrence = seen.get(raw.type) ?? 0;
    seen.set(raw.type, occurrence + 1);
    const prior = cachedByType.get(raw.type)?.[occurrence];
    if (!prior) return raw;

    if (raw.type === "data-image" && prior.type === "data-image") {
      const part = raw as T & {
        data: { images: Array<Record<string, unknown>> };
      };
      const memo = prior as T & {
        data: { images: Array<Record<string, unknown>> };
      };
      const images = part.data.images.map((asset, index) => {
        const remembered = memo.data.images[index];
        if (
          typeof asset.url !== "string" ||
          !asset.url.startsWith("data:") ||
          typeof remembered?.blobId !== "string"
        ) {
          return asset;
        }
        return {
          ...asset,
          blobId: remembered.blobId,
          ...(typeof remembered.blobUrl === "string"
            ? { blobUrl: remembered.blobUrl }
            : {}),
        };
      });
      return { ...part, data: { ...part.data, images } } as T;
    }

    if (raw.type === "file" && prior.type === "file") {
      const part = raw as T & {
        url: string;
        providerMetadata?: Record<string, unknown>;
      };
      const memo = prior as T & {
        providerMetadata?: Record<string, unknown>;
      };
      const currentDial = part.providerMetadata?.dial;
      const memoDial = memo.providerMetadata?.dial;
      if (
        !part.url.startsWith("data:") ||
        !memoDial ||
        typeof memoDial !== "object" ||
        typeof (memoDial as Record<string, unknown>).blobId !== "string"
      ) {
        return raw;
      }
      const remembered = memoDial as Record<string, unknown>;
      return {
        ...part,
        providerMetadata: {
          ...part.providerMetadata,
          dial: {
            ...(typeof memoDial === "object" ? memoDial : {}),
            ...(currentDial && typeof currentDial === "object" ? currentDial : {}),
            blobId: remembered.blobId,
            ...(typeof remembered.blobUrl === "string"
              ? { blobUrl: remembered.blobUrl }
              : {}),
          },
        },
      } as T;
    }

    return raw;
  });
}

type TextPart = { type: string; text?: unknown };
type MessageLike = { id: string; parts: readonly TextPart[] };

function streamedText(message: MessageLike): string {
  return message.parts
    .filter(
      (part) =>
        (part.type === "text" || part.type === "reasoning") &&
        typeof part.text === "string",
    )
    .map((part) => `${part.type}:${part.text as string}`)
    .join("\u001f");
}

/**
 * True when a remote transcript contains a strict prefix of text this tab
 * already holds under the same message id.
 *
 * This is the unmistakable shape of a delayed streaming checkpoint. It is
 * safe to reject while still allowing a real edit from another device: an
 * edit changes content rather than merely ending earlier at the same prefix.
 */
export function isStreamingRollback(
  local: readonly MessageLike[],
  remote: readonly MessageLike[],
): boolean {
  const remoteById = new Map(remote.map((message) => [message.id, message]));
  for (const message of local) {
    const candidate = remoteById.get(message.id);
    if (!candidate) continue;
    const held = streamedText(message);
    const incoming = streamedText(candidate);
    if (held.length > incoming.length && held.startsWith(incoming)) return true;
  }
  return false;
}
