import { useEffect } from "react";
import { applyGlassLevel, loadGlassLevel } from "../lib/glass";

/*
 * The refraction filter every glass panel points its backdrop-filter at.
 * Soft fractal noise displaces what sits behind the glass, so the ribbons
 * bend and ripple through it; the red and blue channels are pushed a little
 * further than green for the chromatic fringe. Strength comes from the
 * Settings slider (lib/glass.ts sets the scale). Rendered once, hidden.
 */
export default function GlassFilter() {
  useEffect(() => {
    applyGlassLevel(loadGlassLevel());
  }, []);
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="tf-refract" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.009" numOctaves={2} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
        <feDisplacementMap id="tf-refract-map" in="SourceGraphic" in2="soft" scale="60" xChannelSelector="R" yChannelSelector="G" result="bent" />
        <feOffset in="bent" dx="1.2" dy="0" result="rShift" />
        <feColorMatrix in="rShift" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
        <feColorMatrix in="bent" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
        <feOffset in="bent" dx="-1.2" dy="0" result="bShift" />
        <feColorMatrix in="bShift" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
        <feBlend in="r" in2="g" mode="screen" result="rg" />
        <feBlend in="rg" in2="b" mode="screen" />
      </filter>
    </svg>
  );
}
