import type { CSSProperties } from 'react';

export type IconName = 'arrow' | 'chevron' | 'plus' | 'close' | 'image' | 'emptyImage' | 'cube' | 'settings' | 'link' | 'download' | 'refresh' | 'flower' | 'poster' | 'brush' | 'check' | 'stop' | 'spark' | 'expand' | 'trash';
const paths: Record<IconName, React.ReactNode> = {
  arrow: <><path d="M4 12h16M14 6l6 6-6 6" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8" cy="8" r="1.4" /><path d="m4 17 5-6 4 4 3-3 5 6" /></>,
  emptyImage: <><rect x="2" y="2" width="20" height="20" rx="3" /><path d="m3 17 6-7 5 5 3-3 5 6" /></>,
  cube: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5" /></>,
  settings: <><path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  link: <><path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-2l1.5 2M4 17l1.5 2a8 8 0 0 0 13-2" /></>,
  flower: <><path d="M12 9c-6-10-12 1-5 4-6 7 5 11 7 4 9 4 12-7 4-8 1-7-9-9-9-2" /><circle cx="12" cy="12" r="2.5" /></>,
  poster: <><path d="M6 3h9l4 4v14H6V3ZM14 3v5h5M9 12h7M9 16h7" /></>,
  brush: <><path d="m13 11 7-7c2-2 4 0 2 2l-7 7-2-2ZM13 11c-3-3-6 0-6 3 0 2-2 4-4 4 5 3 10 1 10-2l2-3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  spark: <path d="M12 2c1.7 6.3 3.7 8.3 10 10-6.3 1.7-8.3 3.7-10 10C10.3 15.7 8.3 13.7 2 12c6.3-1.7 8.3-3.7 10-10Z" />,
  expand: <><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
};
export default function Icon({ name, size = 20, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className={className}>{paths[name]}</svg>;
}
