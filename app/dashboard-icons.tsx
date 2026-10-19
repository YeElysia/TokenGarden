import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "tokens"
  | "calendar"
  | "model"
  | "device"
  | "arrow"
  | "refresh"
  | "reset"
  | "input"
  | "output";

const paths: Record<IconName, string> = {
  activity:
    "M3 3h5v5H3zm7 0h5v5h-5zm7 0h4v5h-4zM3 10h5v5H3zm7 0h5v5h-5zm7 0h4v5h-4zM3 17h5v4H3zm7 0h5v4h-5zm7 0h4v4h-4z",
  tokens: "M3 15h4v6H3zm7-6h4v12h-4zm7-6h4v18h-4zM3 3h8v2H3zm0 5h4v2H3z",
  calendar: "M6 2h3v4h6V2h3v4h3v16H3V6h3zm0 9v8h12v-8zm2 2h3v4H8zm5 0h3v4h-3z",
  model:
    "M4 3h7v7H4zm9 11h7v7h-7zM13 3h7v7h-7zM4 14h7v7H4zm7-9h2v3h-2zm0 11h2v3h-2zM6 10h3v4H6zm9 0h3v4h-3z",
  device: "M3 3h18v13H3zm3 3v7h12V6zm4 10h4v3h5v3H5v-3h5z",
  arrow: "M4 10h11L10 5l2-2 9 9-9 9-2-2 5-5H4z",
  refresh: "M19 4v6h-6l2-2a6 6 0 1 0 2 6h3A9 9 0 1 1 17 6z",
  reset: "M5 3 3 5l7 7-7 7 2 2 7-7 7 7 2-2-7-7 7-7-2-2-7 7z",
  input: "M3 3h8v3H6v12h5v3H3zm11 3 7 6-7 6v-4H8v-4h6z",
  output: "M13 3h8v18h-8v-3h5V6h-5zM3 6l7 6-7 6v-4h11v-4H3z",
};

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}
