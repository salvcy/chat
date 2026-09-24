/**
 * The mark: a tuner's level readout — three bars in an inverted tile, after
 * the channel-style model switcher. Foreground on background, so it inverts
 * with the theme and never needs a colour.
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
      <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden>
        <rect width="20" height="20" rx="6" fill="currentColor" />
        <g fill="var(--background)">
          <rect x="5" y="8.5" width="2" height="5" rx="1" />
          <rect x="9" y="5.5" width="2" height="8" rx="1" />
          <rect x="13" y="9.5" width="2" height="4" rx="1" />
        </g>
      </svg>
      {withName && (
        <span className="text-[14px] font-semibold tracking-[-0.02em]">Chat</span>
      )}
    </span>
  );
}
