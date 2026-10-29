/**
 * The calendar's "posted to X" tick is Tyrone's own bookkeeping, so it shows
 * only on his own brand. There is no own-brand flag on a client, so the brand
 * name decides; every client brand keeps a calendar without it.
 */
export const isOwnBrand = (name: string | null | undefined): boolean => name?.trim().toLowerCase() === "torerone";

/** The local calendar day as YYYY-MM-DD, the key the server stores. */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Posted to X on Wed Oct 28", fixed English to match the day headers. */
export const xPostedLabel = (d: Date): string => `Posted to X on ${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
