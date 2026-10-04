/**
 * A document mark for attachments that have no thumbnail.
 *
 * A filename in a 64px square truncates to nothing legible, so the glyph
 * carries the meaning and the name moves to the tooltip. Drawn rather than
 * imported: one inline path costs less than a dependency and inherits
 * `currentColor`, so it follows the theme with no second definition.
 */
export default function FileGlyph({
  kind,
  className = "",
}: {
  kind: string;
  className?: string;
}) {
  const label = kind === "application/pdf" ? "PDF" : "FILE";
  return (
    <span
      className={`flex flex-col items-center justify-center gap-1 ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2.75H7.5A1.75 1.75 0 0 0 5.75 4.5v15A1.75 1.75 0 0 0 7.5 21.25h9a1.75 1.75 0 0 0 1.75-1.75V7z" />
        <path d="M13.75 3v3.5a1.5 1.5 0 0 0 1.5 1.5h3" />
      </svg>
      <span className="font-mono text-[8px] leading-none tracking-wider">
        {label}
      </span>
    </span>
  );
}
