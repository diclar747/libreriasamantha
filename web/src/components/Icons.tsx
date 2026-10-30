// Iconos de trazo (24x24), sin dependencias.
const P: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
  pos: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v2h-5zM15 18h5v2h-5z',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
  wallet: 'M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7l2-3h12M16 14h3',
  bag: 'M5 8h14l-1 12H6zM9 8a3 3 0 016 0',
  print: 'M7 9V3h10v6M7 17H4v-6h16v6h-3M7 14h10v7H7z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  truck: 'M2 6h11v10H2zM13 9h4l3 3v4h-7M6 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
  factory: 'M3 21V9l6 4V9l6 4V5h6v16zM7 17h2M13 17h2M17 17h2',
  users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M16 11a3 3 0 100-6M18 14a5 5 0 013 6',
  book: 'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 005 12a7 7 0 00.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  wifioff: 'M3 3l18 18M8.5 8.8A10 10 0 003 12.5M5.5 15.5a7 7 0 013.3-2M12 19.5h.01M16 11.2a10 10 0 015 2.3',
  logout: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9',
  chat: 'M4 5h16v11H9l-5 4z',
  bell: 'M6 17h12l-1.5-2V11a4.5 4.5 0 00-9 0v4zM10 20a2 2 0 004 0',
  camera: 'M4 8h3l1.5-2h7L17 8h3v11H4zM12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  search: 'M11 18a7 7 0 110-14 7 7 0 010 14zM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  transfer: 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4',
  check: 'M3 5h18v14H3zM6 10h5M6 14h8M17 14l1.5 1.5L21 12',
  credit: 'M4 4h16v16H4zM8 9h8M8 13h5M8 17h4',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  tick: 'M4 12l5 5L20 6',
  expand: 'M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3',
  shrink: 'M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3',
}

export type IconName = keyof typeof P

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  )
}
