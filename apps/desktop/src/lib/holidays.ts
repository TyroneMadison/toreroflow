/**
 * US holidays and popular observances, computed by rule so every year works
 * offline. Emoji artwork is Apple's set (bundled images, not system emoji).
 */
import newYear from "../assets/emoji/new-year.png";
import mlk from "../assets/emoji/mlk.png";
import superBowl from "../assets/emoji/super-bowl.png";
import valentines from "../assets/emoji/valentines.png";
import presidents from "../assets/emoji/presidents.png";
import stPatricks from "../assets/emoji/st-patricks.png";
import easterImg from "../assets/emoji/easter.png";
import cinco from "../assets/emoji/cinco.png";
import mothers from "../assets/emoji/mothers.png";
import memorial from "../assets/emoji/memorial.png";
import fathers from "../assets/emoji/fathers.png";
import juneteenth from "../assets/emoji/juneteenth.png";
import july4 from "../assets/emoji/july4.png";
import labor from "../assets/emoji/labor.png";
import indigenous from "../assets/emoji/indigenous.png";
import halloween from "../assets/emoji/halloween.png";
import veterans from "../assets/emoji/veterans.png";
import thanksgiving from "../assets/emoji/thanksgiving.png";
import xmasEve from "../assets/emoji/xmas-eve.png";
import christmas from "../assets/emoji/christmas.png";
import nye from "../assets/emoji/nye.png";

export interface Holiday {
  name: string;
  emoji: string;
}

/** nth weekday of a month; n < 0 counts from the end (-1 = last). */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = new Date(year, month, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return new Date(year, month, 1 + offset + (n - 1) * 7);
  }
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - offset + (n + 1) * 7);
}

/** Easter Sunday (Anonymous Gregorian computus). */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

const key = (d: Date): string => `${d.getMonth()}-${d.getDate()}`;

const yearCache = new Map<number, Map<string, Holiday>>();

function computeYear(year: number): Map<string, Holiday> {
  const map = new Map<string, Holiday>();
  const put = (d: Date, name: string, emoji: string) => map.set(key(d), { name, emoji });

  put(new Date(year, 0, 1), "New Year's Day", newYear);
  put(nthWeekday(year, 0, 1, 3), "MLK Jr. Day", mlk);
  put(nthWeekday(year, 1, 0, 2), "Super Bowl Sunday", superBowl);
  put(new Date(year, 1, 14), "Valentine's Day", valentines);
  put(nthWeekday(year, 1, 1, 3), "Presidents' Day", presidents);
  put(new Date(year, 2, 17), "St. Patrick's Day", stPatricks);
  put(easter(year), "Easter", easterImg);
  put(new Date(year, 4, 5), "Cinco de Mayo", cinco);
  put(nthWeekday(year, 4, 0, 2), "Mother's Day", mothers);
  put(nthWeekday(year, 4, 1, -1), "Memorial Day", memorial);
  put(new Date(year, 5, 19), "Juneteenth", juneteenth);
  put(nthWeekday(year, 5, 0, 3), "Father's Day", fathers);
  put(new Date(year, 6, 4), "Independence Day", july4);
  put(nthWeekday(year, 8, 1, 1), "Labor Day", labor);
  put(nthWeekday(year, 9, 1, 2), "Indigenous Peoples' Day", indigenous);
  put(new Date(year, 9, 31), "Halloween", halloween);
  put(new Date(year, 10, 11), "Veterans Day", veterans);
  put(nthWeekday(year, 10, 4, 4), "Thanksgiving", thanksgiving);
  put(new Date(year, 11, 24), "Christmas Eve", xmasEve);
  put(new Date(year, 11, 25), "Christmas", christmas);
  put(new Date(year, 11, 31), "New Year's Eve", nye);
  return map;
}

export function holidayFor(date: Date): Holiday | null {
  let map = yearCache.get(date.getFullYear());
  if (!map) {
    map = computeYear(date.getFullYear());
    yearCache.set(date.getFullYear(), map);
  }
  return map.get(key(date)) ?? null;
}
