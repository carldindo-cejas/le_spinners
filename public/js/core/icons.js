import { raw } from './dom.js';

/** Stroke icons from the design system (24×24, round caps). */
const PATHS = {
  home: 'M3.5 10.5L12 3.5l8.5 7V19a2 2 0 0 1-2 2H15v-6H9v6H5.5a2 2 0 0 1-2-2z',
  ticket: 'M4 5.5h16a1 1 0 0 1 1 1V9a2.5 2.5 0 0 0 0 5v2.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V14a2.5 2.5 0 0 0 0-5V6.5a1 1 0 0 1 1-1zM14.5 5.5v2M14.5 10.75v2.5M14.5 16v1.5',
  plus: 'M12 5v14M5 12h14',
  bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 21a2 2 0 0 0 4 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0',
  grid: 'M5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9 10.5H5A1.5 1.5 0 0 1 3.5 9V5A1.5 1.5 0 0 1 5 3.5zM15 3.5h4A1.5 1.5 0 0 1 20.5 5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13.5 9V5A1.5 1.5 0 0 1 15 3.5zM5 13.5h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9 20.5H5A1.5 1.5 0 0 1 3.5 19v-4A1.5 1.5 0 0 1 5 13.5zM15 13.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5z',
  'shield-clock': 'M12 3l7.5 3v5.4c0 4.6-3.2 8.4-7.5 9.6-4.3-1.2-7.5-5-7.5-9.6V6zM12 8.5V12l2.5 1.5',
  'shield-check': 'M12 3l7.5 3v5.4c0 4.6-3.2 8.4-7.5 9.6-4.3-1.2-7.5-5-7.5-9.6V6zM8.8 12l2.3 2.3 4.3-4.6',
  chat: 'M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.6A8.5 8.5 0 1 1 20.5 12z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  layers: 'M12 3.5l9 4.5-9 4.5-9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5',
  'calendar-clock': 'M6 4.5h12a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3zM3 9.5h18M8 2.5v4M16 2.5v4M12 12.5v3l2 1.5',
  'calendar-grid': 'M4 4.5h16v15H4zM4 9.5h16M9.3 4.5v15M14.7 4.5v15',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.3A6.5 6.5 0 0 1 21.5 20',
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  logout: 'M14.5 4h3.5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5M10 16.5L5.5 12 10 7.5M5.5 12H15',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'check-circle': 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12.5l2.8 2.8L16 9.8',
  'x-circle': 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6',
  'circle-slash': 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M5.7 5.7l12.6 12.6',
  'minus-circle': 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12h8',
  'clock-x': 'M20.5 12A8.5 8.5 0 1 0 12 20.5M12 7v5l3 2M16 16l5 5M21 16l-5 5',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  hourglass: 'M6.5 3h11M6.5 21h11M8 3c0 4.5 4 5.5 4 9s-4 4.5-4 9M16 3c0 4.5-4 5.5-4 9s4 4.5 4 9',
  lock: 'M6.5 10.5h11a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2zM8 10.5V7.5a4 4 0 0 1 8 0v3',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.3 5.3l-5.8 5.8a1.9 1.9 0 0 0 2.7 2.7l5.8-5.8a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.3-.3-2.4z',
  'play-circle': 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M10 8.5l5 3.5-5 3.5z',
  info: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v5.5M12 7.8v.01',
  alert: 'M10.3 4.2L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0zM12 9.5v4.5M12 17.2v.01',
  bang: 'M12 7v6M12 16.5v.01',
  'wifi-off': 'M3 3l18 18M8.6 16.4a4.8 4.8 0 0 1 6.8 0M5.2 12.9a9.6 9.6 0 0 1 4.3-2.4M18.8 12.9a9.6 9.6 0 0 0-2.1-1.6M2 9.2a14.4 14.4 0 0 1 3.8-2.6M22 9.2A14.4 14.4 0 0 0 11 5.6M12 20h.01',
  x: 'M6 6l12 12M18 6L6 18',
  'chevron-left': 'M15 6l-6 6 6 6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  'arrow-right': 'M5 12h14M13 5.5l6.5 6.5-6.5 6.5',
  'arrow-left': 'M19 12H5M11 5.5L4.5 12l6.5 6.5',
  copy: 'M10 8.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8.5 19v-9A1.5 1.5 0 0 1 10 8.5zM15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5',
  upload: 'M12 15.5V4M7 8.5L12 3.5l5 5M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15',
  download: 'M12 3.5V15M7 10l5 5 5-5M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.9-3.9',
  filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v5h-5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  'eye-off': 'M3 3l18 18M10.6 5.6A10.9 10.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-3 3.7M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  send: 'M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z',
  edit: 'M4 20h4.2L19.3 8.9a2.8 2.8 0 0 0-4-4L4 16.2zM13.8 6.4l3.8 3.8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  calendar: 'M6 4.5h12a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3zM3 9.5h18M8 2.5v4M16 2.5v4',
  'calendar-plus': 'M6 4.5h12a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3zM3 9.5h18M8 2.5v4M16 2.5v4M12 12.5v5M9.5 15h5',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3.2 2',
  paddle: 'M9 2.5h6a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4zM10.5 15.5v5a1.5 1.5 0 0 0 3 0v-5',
  pingpong: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM14.6 14.6l5.4 5.4M19 8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  court: 'M3.5 5.5h17v13h-17zM12 5.5v13M3.5 12h17',
  phone: 'M5.5 3.5h3l1.8 4.6-2.3 1.4a10.5 10.5 0 0 0 6.5 6.5l1.4-2.3 4.6 1.8v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3.5 5.5a2 2 0 0 1 2-2z',
  'map-pin': 'M12 21s-7-6.1-7-11.4a7 7 0 0 1 14 0C19 14.9 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  image: 'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM3.5 16l5-5 4 4 2.5-2.5 5.5 5.5M15.5 9.5v.01',
  paperclip: 'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8',
  'rotate-cw': 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v5h-5',
  'zoom-in': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.9-3.9M11 8v6M8 11h6',
  'zoom-out': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.9-3.9M8 11h6',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2M14 18h2v2M18 18h2v2',
  install: 'M12 3.5V14M7.5 9.5L12 14l4.5-4.5M5 17.5h14M7 21h10',
};

/** Returns trusted SVG markup for an icon. */
export function icon(name, size = 20, stroke = 2, extraClass = '') {
  const d = PATHS[name];
  if (!d) return raw('');
  const paths = (Array.isArray(d) ? d : [d]).map((p) => `<path d="${p}"/>`).join('');
  const sw = name === 'more' ? 3 : stroke;
  return raw(
    `<svg class="ic${extraClass ? ` ${extraClass}` : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`,
  );
}

/** The Le Spinners mark. `inverse` for use on blue. */
export function logo(size = 38, inverse = false) {
  const bg = inverse ? '#FFFFFF' : '#2350E0';
  const fg = inverse ? '#2350E0' : '#C9F24D';
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect width="48" height="48" rx="13" fill="${bg}"/><path d="M10.2 21.6A14 14 0 0 1 26.4 10.2" fill="none" stroke="${fg}" stroke-width="3.2" stroke-linecap="round"/><path d="M37.8 26.4A14 14 0 0 1 21.6 37.8" fill="none" stroke="${fg}" stroke-width="3.2" stroke-linecap="round"/><circle cx="24" cy="24" r="8" fill="${fg}"/></svg>`,
  );
}

/** Court drawing for tiles and cards. */
export function courtArt(className = '') {
  return raw(
    `<svg class="${className}" viewBox="0 0 176 80" aria-hidden="true" focusable="false"><rect x="2" y="2" width="172" height="76" rx="2" fill="#2350E0" stroke="#FFFFFF" stroke-width="2.5"/><path d="M60 2v76M116 2v76M2 40h58M116 40h58" stroke="#FFFFFF" stroke-width="2" fill="none"/><path d="M88 -2v84" stroke="#FFFFFF" stroke-width="3.5"/><circle cx="136" cy="22" r="5" fill="#C9F24D"/></svg>`,
  );
}

/** Table-tennis table drawing. */
export function tableArt(className = '') {
  return raw(
    `<svg class="${className}" viewBox="0 0 176 98" aria-hidden="true" focusable="false"><rect x="2" y="2" width="172" height="94" rx="3" fill="#2350E0" stroke="#FFFFFF" stroke-width="3"/><path d="M2 49h172" stroke="#FFFFFF" stroke-width="1.5"/><path d="M88 -4v106" stroke="#FFFFFF" stroke-width="4"/><circle cx="40" cy="28" r="5" fill="#FFFFFF"/></svg>`,
  );
}

/** Small glyph used inside 52px resource tiles. */
export function resourceGlyph(activity, onBlue = false) {
  if (activity === 'table_tennis') {
    return raw(
      `<svg width="34" height="20" viewBox="0 0 44 26" aria-hidden="true" focusable="false"><rect x="1" y="1" width="42" height="24" rx="2" fill="${onBlue ? 'none' : '#0D1626'}" stroke="${onBlue ? '#FFFFFF' : '#0D1626'}" stroke-width="1.4"/><path d="M1 13h42M22 0v26" stroke="${onBlue ? '#FFFFFF' : '#C9F24D'}" stroke-width="1.4"/></svg>`,
    );
  }
  return raw(
    `<svg width="34" height="16" viewBox="0 0 44 20" aria-hidden="true" focusable="false"><rect x="1" y="1" width="42" height="18" fill="${onBlue ? 'none' : '#2350E0'}" stroke="${onBlue ? '#FFFFFF' : '#2350E0'}" stroke-width="1.4"/><path d="M15 1v18M29 1v18M1 10h14M29 10h14M22 0v20" stroke="#FFFFFF" stroke-width="1.2"/></svg>`,
  );
}

/** Dashed court for empty states. */
export function emptyArt() {
  return raw(
    `<svg width="132" height="64" viewBox="0 0 176 86" aria-hidden="true" focusable="false"><rect x="2" y="4" width="172" height="76" rx="2" fill="none" stroke="#CFCCC0" stroke-width="2.5" stroke-dasharray="6 6"/><path d="M60 4v76M116 4v76M2 42h58M116 42h58" stroke="#E3E1D9" stroke-width="2" fill="none"/><path d="M88 0v86" stroke="#CFCCC0" stroke-width="3"/><circle cx="136" cy="24" r="6" fill="#C9F24D"/></svg>`,
  );
}
