/**
 * The tile: a squircle on a 20 grid — Apple's continuous corner at radius 6,
 * so the sides flow into the corners instead of meeting an arc. The same
 * shape, scaled, is the favicon (`public/brand/`) and the desktop app's icon
 * (`../Tauri/assets/`); change all three together.
 */
const SQUIRCLE =
  "M9.172 0H10.828C13.469 0 14.79 0.126 16.211 0.449C17.763 1.014 18.986 2.237 19.551 3.789C19.874 5.21 20 6.531 20 9.172V10.828C20 13.469 19.874 14.79 19.551 16.211C18.986 17.763 17.763 18.986 16.211 19.551C14.79 19.874 13.469 20 10.828 20H9.172C6.531 20 5.21 19.874 3.789 19.551C2.237 18.986 1.014 17.763 0.449 16.211C0.126 14.79 0 13.469 0 10.828V9.172C0 6.531 0.126 5.21 0.449 3.789C1.014 2.237 2.237 1.014 3.789 0.449C5.21 0.126 6.531 0 9.172 0Z";

/**
 * The mark: a slash in a squircle — the stroke that starts a command.
 * Foreground tile, background slash, so it inverts with the theme and never
 * needs a colour.
 */
export default function BrandMark({
  withName = true,
  className = "",
}: {
  withName?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 text-foreground ${className}`}>
      <svg
        viewBox="0 0 20 20"
        className="h-5 w-5 shrink-0"
        role={withName ? undefined : "img"}
        aria-label={withName ? undefined : "Chat"}
        aria-hidden={withName || undefined}
      >
        <path d={SQUIRCLE} fill="currentColor" />
        <path
          d="M7.7 14.3 12.3 5.7"
          stroke="var(--background)"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
      </svg>
      {withName && (
        <span className="text-[14px] font-semibold tracking-[-0.02em]">Chat</span>
      )}
    </span>
  );
}
