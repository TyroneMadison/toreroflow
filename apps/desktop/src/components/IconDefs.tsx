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
      <symbol id="i-cal" viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </symbol>
      <symbol id="i-chart" viewBox="0 0 24 24">
        <path d="M18 20V10M12 20V4M6 20v-6" />
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
      <symbol id="i-image" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </symbol>
      <symbol id="i-crop" viewBox="0 0 24 24">
        <path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" />
      </symbol>
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
    </svg>
  );
}
