import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>;
}

export const Icons = {
  home: (p: IconProps) => <Icon {...p}><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></Icon>,
  signal: (p: IconProps) => <Icon {...p}><path d="M4 18v-3m5 3V9m5 9V6m5 12V3" /></Icon>,
  study: (p: IconProps) => <Icon {...p}><path d="M4 4h16v16H4zM8 9h8M8 13h5" /></Icon>,
  evidence: (p: IconProps) => <Icon {...p}><path d="M6 3h9l3 3v15H6zM9 12l2 2 4-5" /></Icon>,
  action: (p: IconProps) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>,
  audit: (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11l2 2 4-5" /></Icon>,
  search: (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4" /></Icon>,
  bell: (p: IconProps) => <Icon {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></Icon>,
  chevron: (p: IconProps) => <Icon {...p}><path d="m9 18 6-6-6-6" /></Icon>,
  trend: (p: IconProps) => <Icon {...p}><path d="m3 17 6-6 4 4 8-9M15 6h6v6" /></Icon>,
  shield: (p: IconProps) => <Icon {...p}><path d="M12 3 4.5 6v5c0 5 3.2 8.4 7.5 10 4.3-1.6 7.5-5 7.5-10V6Z"/><path d="m9 12 2 2 4-5" /></Icon>,
  globe: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></Icon>,
  menu: (p: IconProps) => <Icon {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>,
  close: (p: IconProps) => <Icon {...p}><path d="m6 6 12 12M18 6 6 18" /></Icon>,
  learning: (p: IconProps) => <Icon {...p}><path d="M4 5h6a3 3 0 0 1 3 3v11a2.5 2.5 0 0 0-2.5-2.5H4Zm16 0h-6a3 3 0 0 0-3 3v11a2.5 2.5 0 0 1 2.5-2.5H20Z" /></Icon>,
  catalog: (p: IconProps) => <Icon {...p}><path d="M4 6h7v5H4zM13 6h7v5h-7zM4 13h7v5H4zM13 13h7v5h-7z" /></Icon>,
  info: (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" /></Icon>,
};
