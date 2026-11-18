/**
 * SVG symbol sprite ported verbatim from the design prototype.
 * Rendered once in App; icons are referenced via <svg><use href="#i-..." /></svg>.
 */
export default function IconDefs() {
  return (
    <svg style={{ display: "none" }}>
      <symbol id="i-upload" viewBox="0 0 24 24">
        <path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" />
        <path d="M12 16V4" />
        <path d="M8 8l4-4 4 4" />
      </symbol>
      <symbol id="i-dash" viewBox="0 0 24 24">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </symbol>
      <symbol id="i-gear" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </symbol>
      <symbol id="i-cal" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </symbol>
      <symbol id="i-chart" viewBox="0 0 24 24">
        <path d="M18 20V10M12 20V4M6 20v-6" />
      </symbol>
      <symbol id="i-report" viewBox="0 0 24 24">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <path d="M14 3v6h6M8 17v-3M12 17v-6M16 17v-2" />
      </symbol>
      <symbol id="i-users" viewBox="0 0 24 24">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </symbol>
      <symbol id="i-sliders" viewBox="0 0 24 24">
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
      </symbol>
      <symbol id="i-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </symbol>
      <symbol id="i-bell" viewBox="0 0 24 24">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </symbol>
      <symbol id="i-clock" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </symbol>
      <symbol id="i-chev" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" />
      </symbol>
      <symbol id="i-up" viewBox="0 0 24 24">
        <path d="M5 12l7-7 7 7M12 5v14" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 24 24">
        <path d="M6 4l14 8-14 8z" />
      </symbol>
      <symbol id="i-bolt" viewBox="0 0 24 24">
        <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
      </symbol>
      <symbol id="i-dl" viewBox="0 0 24 24">
        <path d="M12 3v12M8 11l4 4 4-4M4 21h16" />
      </symbol>
      <symbol id="i-globe" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
      </symbol>
      <symbol id="i-moon" viewBox="0 0 24 24">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </symbol>
      <symbol id="i-sun" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 24 24">
        <path d="M18 6L6 18M6 6l12 12" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 24 24">
        <path d="M20 6L9 17l-5-5" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 24 24">
        <rect x="9" y="9" width="12" height="12" rx="2.5" />
        <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </symbol>
      <symbol id="i-image" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </symbol>
      <symbol id="i-crop" viewBox="0 0 24 24">
        <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />
      </symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </symbol>
      <symbol id="i-usd" viewBox="0 0 24 24">
        <path d="M12 2v20M17 6.5c0-2-2.2-3.5-5-3.5S7 4.5 7 6.5s2 3 5 3.5 5 1.5 5 3.5-2.2 3.5-5 3.5-5-1.5-5-3.5" />
      </symbol>
      <symbol id="i-lock" viewBox="0 0 24 24">
        <rect x="4" y="11" width="16" height="10" rx="2.5" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </symbol>
      <symbol id="i-unlock" viewBox="0 0 24 24">
        <rect x="4" y="11" width="16" height="10" rx="2.5" />
        <path d="M8 11V7a4 4 0 0 1 7.5-2" />
      </symbol>
      <symbol id="i-alert" viewBox="0 0 24 24">
        <path d="M12 3.5L2.8 19.5a1.4 1.4 0 0 0 1.2 2h16a1.4 1.4 0 0 0 1.2-2z" />
        <path d="M12 9.5v4.5M12 17.6v.01" />
      </symbol>
      <symbol id="i-pencil" viewBox="0 0 24 24">
        <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
        <path d="M14.5 6.5l3 3" />
      </symbol>
      <symbol id="i-film" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21" />
      </symbol>
      {/* phone glyphs (mobile pass), drawn like the rest: stroke, currentColor */}
      <symbol id="i-bulb" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></symbol>
      <symbol id="i-dots-h" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></symbol>
      <symbol id="i-dots-v" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/></symbol>
      <symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></symbol>
      <symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3 2 8l10 5 10-5zM2 16l10 5 10-5M2 12l10 5 10-5"/></symbol>
      <symbol id="i-chev-l" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></symbol>
      <symbol id="i-chev-r" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></symbol>
      <symbol id="i-chev-u" viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></symbol>
      <symbol id="i-arrow-r" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
      <symbol id="i-arrow-l" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></symbol>
      <symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></symbol>
      <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
      <symbol id="i-list" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></symbol>
      <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></symbol>
      <symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
      <symbol id="i-send" viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></symbol>
      <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
      <symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></symbol>
      <symbol id="i-comment" viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.7A8.4 8.4 0 1 1 21 11.5z"/></symbol>
      <symbol id="i-share" viewBox="0 0 24 24"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></symbol>
      <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z"/></symbol>
      <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
      <symbol id="i-drive" viewBox="0 0 24 24"><path d="M8 3.5h8l6 10.5-3.6 6.5H5.6L2 14z"/><path d="M8 3.5l7 12.5M16 3.5L9 16M2 14h14"/></symbol>
      <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/></symbol>
      <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></symbol>
      <symbol id="i-wand" viewBox="0 0 24 24"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/></symbol>
      <symbol id="i-scissors" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/></symbol>
      <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></symbol>
      <symbol id="i-type" viewBox="0 0 24 24"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></symbol>
      <symbol id="i-music" viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/></symbol>
      <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></symbol>
      <symbol id="i-logout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></symbol>
      <symbol id="i-wifi-off" viewBox="0 0 24 24"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5-2.5M19 12.6a10 10 0 0 0-2.2-1.6M2 8.8a15 15 0 0 1 4.3-2.6M22 8.8A15 15 0 0 0 10.7 5M12 20h.01"/></symbol>
      <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
      <symbol id="i-video" viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2.5"/><path d="M16 10l6-4v12l-6-4"/></symbol>
      <symbol id="i-repeat" viewBox="0 0 24 24"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/></symbol>
      <symbol id="i-trend-up" viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8M14 7h7v7"/></symbol>
      <symbol id="i-trend-down" viewBox="0 0 24 24"><path d="M3 7l6 6 4-4 8 8M14 17h7v-7"/></symbol>
      <symbol id="i-hash" viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/></symbol>
      <symbol id="i-grip" viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></symbol>
      <symbol id="i-tag" viewBox="0 0 24 24"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/></symbol>
      <symbol id="i-bank" viewBox="0 0 24 24"><path d="M3 10h18M5 10v9M19 10v9M9.5 10v9M14.5 10v9M3 20h18M12 3l9 5H3z"/></symbol>
      <symbol id="i-receipt" viewBox="0 0 24 24"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/></symbol>
      <symbol id="i-pie" viewBox="0 0 24 24"><path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 2.6A9 9 0 0 1 21.4 9H15z"/></symbol>
      <symbol id="i-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/></symbol>
      <symbol id="i-x-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/></symbol>
      <symbol id="i-help" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></symbol>
      <symbol id="i-trello" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><rect x="7" y="7" width="3.5" height="9" rx="1"/><rect x="13.5" y="7" width="3.5" height="5.5" rx="1"/></symbol>
      <symbol id="i-key" viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14.5 8.5l2 2"/></symbol>
      <symbol id="i-rocket" viewBox="0 0 24 24"><path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2M9 18l-3-3"/><path d="M14.5 4.5C17 2 21 2 22 2c0 1 0 5-2.5 7.5L12 17l-5-5z"/><circle cx="16" cy="8" r="1.4"/></symbol>
      <symbol id="i-phone" viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></symbol>
      <symbol id="i-desktop" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></symbol>
      <symbol id="i-sort" viewBox="0 0 24 24"><path d="M3 6h13M3 12h9M3 18h5M18 8v12M15 17l3 3 3-3"/></symbol>
      <symbol id="i-expand" viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></symbol>
      <symbol id="i-cc" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10.5 10.2a2 2 0 1 0 0 3.6M17.5 10.2a2 2 0 1 0 0 3.6"/></symbol>
      <symbol id="i-palette" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.9-.8-1.3-.8-2.2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.3-4-7.8-9-7.8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/></symbol>
      <symbol id="i-reply" viewBox="0 0 24 24"><path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2"/></symbol>
      <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></symbol>
      <symbol id="i-hand" viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.4-2.6L3.3 16a1.5 1.5 0 0 1 2.3-2L8 16"/></symbol>
      <symbol id="i-swipe" viewBox="0 0 24 24"><path d="M4 12h13M13 8l4 4-4 4M20 5v14"/></symbol>
      <symbol id="i-wave" viewBox="0 0 24 24"><path d="M2 12h2l2-6 3 12 3-9 2 6 2-3h6"/></symbol>
      <symbol id="i-sliders2" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></symbol>
      <symbol id="i-calplus" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13v6M9 16h6"/></symbol>
      <symbol id="i-dollar" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 9c0-1.1-1.3-2-3-2s-3 .9-3 2 1.3 1.7 3 2 3 .9 3 2-1.3 2-3 2-3-.9-3-2"/></symbol>
      {/* platform logos */}
      <symbol id="p-ig" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="5.2" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <circle cx="12" cy="12" r="4.1" fill="none" stroke="currentColor" strokeWidth="2.1" />
        <circle cx="17.2" cy="6.8" r="1.35" fill="currentColor" />
      </symbol>
      <symbol id="p-tt" viewBox="0 0 24 24">
        <path
          d="M14.2 3c.28 2.28 1.86 3.96 4.1 4.24v3.02c-1.55 0-2.98-.5-4.1-1.36v6.13c0 3.3-2.62 5.66-5.72 5.38-2.6-.24-4.47-2.36-4.28-5 .18-2.44 2.24-4.3 4.7-4.3.38 0 .76.04 1.1.12v3.06a2.3 2.3 0 0 0-1.1-.28c-1.26 0-2.24 1.06-2.06 2.34.12 1.06 1.06 1.9 2.14 1.9 1.26 0 2.28-.98 2.28-2.24V3h2.94z"
          fill="currentColor"
        />
      </symbol>
      <symbol id="p-yt" viewBox="0 0 24 24">
        <rect x="2" y="5.2" width="20" height="13.6" rx="4.2" fill="currentColor" />
        <path d="M10 8.7v6.6l5.6-3.3z" fill="#0a0710" />
      </symbol>
      <symbol id="p-sc" viewBox="0 0 24 24">
        <path
          d="M12 2.7c2.5 0 4.3 1.9 4.4 4.5.02.55.01 1.15-.06 1.78.32.2.72.28 1.05.16.6-.12 1.16.22 1.16.82 0 .5-.5.78-1.08.98-.5.17-1.16.3-1.28.78-.1.42.22.82.6 1.3.6.76 1.55 1.44 2.6 1.74.4.12.6.42.48.8-.22.68-1.66.98-2.54 1.08-.2.02-.3.2-.4.5-.1.4-.22.8-.62.9-.5.12-1.1-.18-1.9-.18-.9 0-1.56.48-2.42.9-.6.28-1.18.28-1.78 0-.86-.42-1.52-.9-2.42-.9-.8 0-1.4.3-1.9.18-.4-.1-.52-.5-.62-.9-.1-.3-.2-.48-.4-.5-.88-.1-2.32-.4-2.54-1.08-.12-.38.08-.68.48-.8 1.05-.3 2-.98 2.6-1.74.38-.48.7-.88.6-1.3-.12-.48-.78-.6-1.28-.78-.58-.2-1.08-.48-1.08-.98 0-.6.56-.94 1.16-.82.33.12.73.04 1.05-.16-.07-.63-.08-1.23-.06-1.78C7.7 4.6 9.5 2.7 12 2.7z"
          fill="currentColor"
        />
      </symbol>
      <symbol id="p-fb" viewBox="0 0 24 24">
        <path
          d="M13.6 21v-6.9h2.3l.44-2.9H13.6V9.3c0-.84.4-1.66 1.7-1.66h1.3V5.16S15.4 4.95 14.3 4.95c-2.36 0-3.9 1.43-3.9 4.02v2.23H8.2v2.9h2.2V21z"
          fill="currentColor"
        />
      </symbol>
    </svg>
  );
}
