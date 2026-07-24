/**
 * Toreroflow design tokens — spec Section 13, matching
 * design/toreroflow-liquid-glass-v4.html exactly.
 */

export const darkTheme = {
  bg0: "#030208",
  bg1: "#080611",
  glass: "rgba(255,255,255,0.05)",
  glass2: "rgba(255,255,255,0.085)",
  glass3: "rgba(255,255,255,0.13)",
  border: "rgba(255,255,255,0.12)",
  borderSoft: "rgba(255,255,255,0.07)",
  text: "rgba(255,255,255,0.94)",
  text2: "rgba(255,255,255,0.58)",
  text3: "rgba(255,255,255,0.36)",
} as const;

export const lightTheme = {
  bg0: "#e8eaf4",
  bg1: "#f3f4fb",
  glass: "rgba(255,255,255,0.6)",
  glass2: "rgba(255,255,255,0.82)",
  glass3: "rgba(30,30,70,0.07)",
  border: "rgba(30,30,70,0.12)",
  borderSoft: "rgba(30,30,70,0.07)",
  text: "rgba(24,26,45,0.94)",
  text2: "rgba(24,26,45,0.62)",
  text3: "rgba(24,26,45,0.42)",
} as const;

export const accents = {
  violet: "#8b7bff",
  blue: "#4ea8ff",
  gradient: "linear-gradient(135deg,#8b7bff 0%,#4ea8ff 100%)",
  success: "#57d6a0",
  warning: "#ffcf6b",
  danger: "#ff6b7a",
} as const;

export const radii = {
  card: 26,
  input: 16,
  chip: 13,
} as const;

export const blur = "blur(38px) saturate(150%)";

export const font =
  '-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif';

export const platformColors = {
  instagram: { gradient: ["#feda75", "#d62976", "#7a34c9"] },
  tiktok: { cyan: "#25f4ee", pink: "#fe2c55", bg: "#0a0710" },
  youtube: { red: "#ff4237" },
  snapchat: { yellow: "#ffe600" },
} as const;
