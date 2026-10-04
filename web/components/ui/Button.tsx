import type { ButtonHTMLAttributes } from "react";

/*
 * Pill buttons, adapted from Beautiful UI's Button (beautifului.dev, MIT,
 * © 2026 Shane Levine) without its class-variance-authority dependency, and
 * without its accent and success variants — this interface has no colour to
 * give them. Emphasis is carried by fill instead: primary is the inverted
 * block, secondary a lifted surface, quiet nothing at all until hovered.
 *
 * Explicit heights with symmetric padding, so top and bottom spacing stay
 * equal whatever the label. The 0.97 press is the one tactile cue.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet";
export type ButtonSize = "xs" | "sm" | "md";

const BASE =
  "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[transform,background-color,opacity,box-shadow,color] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-foreground text-background shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] hover:opacity-90",
  secondary: "bg-panel text-foreground shadow-btn hover:bg-field",
  ghost: "bg-hover-2 text-foreground hover:bg-surface-strong",
  quiet: "text-secondary hover:bg-hover hover:text-foreground",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-7 gap-1 rounded-full px-2.5 text-[12px]",
  sm: "h-[30px] gap-1.5 rounded-full px-3 text-[13px]",
  md: "h-10 gap-2 rounded-full px-4 text-[13.5px]",
};

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "sm",
  extra = "",
): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

export default function Button({
  variant,
  size,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...props} />
  );
}
