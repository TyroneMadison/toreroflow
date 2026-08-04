import {
  CAROUSEL_ABSOLUTE_MAX,
  carouselTargetSize,
  carouselVerdict,
  INSTAGRAM_CAROUSEL_MAX,
  TIKTOK_CAROUSEL_MAX,
} from "./carouselLimits";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

const imgs = (n: number) => Array.from({ length: n }, () => ({ kind: "image" as const }));
const vids = (n: number) => Array.from({ length: n }, () => ({ kind: "video" as const }));

/*
 * The ceilings themselves. These are the provider's documented numbers, and
 * the asymmetry is the entire feature: if either drifts, every warning in the
 * builder says the wrong thing.
 */
eq(INSTAGRAM_CAROUSEL_MAX, 10, "Instagram's API ceiling is 10, whatever the app allows");
eq(TIKTOK_CAROUSEL_MAX, 35, "TikTok photo posts take 35");
eq(CAROUSEL_ABSOLUTE_MAX, 35, "the tray takes what the roomiest platform takes");

/* A small all-image set goes anywhere. */
{
  const v = carouselVerdict(imgs(6));
  eq(v.instagram.eligible, true, "6 images fit Instagram");
  eq(v.tiktok.eligible, true, "6 images fit TikTok");
  eq(v.unpostable, false, "");
}

/* Exactly at Instagram's ceiling is still eligible; one over is not. */
eq(carouselVerdict(imgs(10)).instagram.eligible, true, "10 is Instagram's ceiling, inclusive");
{
  const v = carouselVerdict(imgs(11));
  eq(v.instagram.eligible, false, "11 images rule Instagram out");
  eq(v.tiktok.eligible, true, "and leave TikTok standing");
  eq(v.unpostable, false, "one platform standing is postable");
}

/* A video rules TikTok out and leaves Instagram standing. */
{
  const v = carouselVerdict([...imgs(3), ...vids(1)]);
  eq(v.tiktok.eligible, false, "a video rules TikTok out");
  eq(v.instagram.eligible, true, "Instagram takes mixed sets");
  eq(v.unpostable, false, "");
}

/*
 * The trap the builder must catch loudly: a video AND more than 10 items.
 * Each platform refuses for a different reason, and together nothing can
 * take the set. The operator must hear this while arranging, not from a
 * publish failure hours later.
 */
{
  const v = carouselVerdict([...imgs(11), ...vids(1)]);
  eq(v.instagram.eligible, false, "12 items rule Instagram out");
  eq(v.tiktok.eligible, false, "the video rules TikTok out");
  eq(v.unpostable, true, "nothing can take it, and the builder must say so");
}

/* An empty tray is not "unpostable", it is just empty. */
eq(carouselVerdict([]).unpostable, false, "an empty tray raises no alarm");

/* Beyond even TikTok. */
eq(carouselVerdict(imgs(36)).tiktok.eligible, false, "36 images fit nowhere");
eq(carouselVerdict(imgs(36)).unpostable, true, "");

/*
 * Output geometry. Even heights because the videos in a set go through the
 * same numbers and H.264 refuses odd dimensions.
 */
eq(carouselTargetSize(1).width, 1080, "square is 1080 wide");
eq(carouselTargetSize(1).height, 1080, "and 1080 tall");
eq(carouselTargetSize(4 / 5).height, 1350, "4:5 portrait is Instagram's 1080x1350");
eq(carouselTargetSize(9 / 16).height, 1920, "9:16 is TikTok's 1080x1920");
eq(carouselTargetSize(0.1).height, 1920, "a degenerate tall crop clamps to 9:16, not a 10,000px strip");
eq(carouselTargetSize(10).height, 566, "a degenerate wide crop clamps to Instagram's 1.91:1");
eq(carouselTargetSize(0.77).height % 2, 0, "heights are always even for H.264");

console.log("carouselLimits: all checks passed");
