import { useEffect } from "react";
import { applyGlassLevel, loadGlassLevel } from "../lib/glass";
import { startRefraction } from "../lib/refraction";

/*
 * The refraction filter every glass panel points its backdrop-filter at.
 * Soft fractal noise displaces what sits behind the glass, so what sits
 * behind it bends and ripples through it. One smooth warp, no colour split (v0.3.28). Strength comes from the
 * Settings slider (lib/glass.ts sets the scale). Rendered once, hidden.
 */
export default function GlassFilter() {
  useEffect(() => {
    const stop = startRefraction();
    applyGlassLevel(loadGlassLevel());
    return stop;
  }, []);
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="tf-refract" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.004 0.006" numOctaves={1} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="4" result="soft" />
        <feDisplacementMap id="tf-refract-map" in="SourceGraphic" in2="soft" scale="60" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
