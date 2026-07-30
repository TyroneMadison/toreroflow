# The app looks like torerone.com, and its dropdowns do too

Improvements list, the item beginning "I want to change the color scheme, color
conventions, to have the same look as my website torerone.com".

## What the site actually is

Read out of `hero-app`, not guessed at from a screenshot.

| Thing | Site |
|---|---|
| Page | `#000`, pure black |
| Accent | `#FF6F61` coral, and nothing else |
| Primary button | `bg-accent` with **black** text |
| Surface | `bg-white/5` with `border border-white/15`, `rounded-xl` |
| Text | white, then white/70, white/50, white/40, placeholder white/30 |
| Focus and hover | `border-accent` |
| Liquid glass | `rgba(255,255,255,.01)` fill, `blur(4px)`, `background-blend-mode: luminosity`, no border, and a 1.4px gradient hairline drawn by `::before` that is bright at the top and bottom edges and invisible in the middle |

The app today is a different brand: near black `#030208`, a purple `#8b7bff`
to blue `#4ea8ff` gradient, 38px blur, 26px radii.

## Decisions

- **The brand colours change, the status colours do not.** Posted, publishing,
  scheduled and failed mean something, and a calendar where everything is the
  accent colour says nothing. Blue stays as `--info` for scheduled and for a
  payment that is due.
- **The failure red moves.** Coral `#FF6F61` and the old red `#ff6b7a` are
  nearly the same hue, so making coral the accent would have left a failed post
  looking like a button. Red becomes `#FF2D55`, which stays alarming next to
  the accent.
- **The glass fill stays heavier than the site's.** The site puts glass over a
  video, so `rgba(255,255,255,.01)` reads. The app puts it over black, where
  the same value is invisible. It keeps a `.05` fill and takes the site's
  border value and its much cheaper blur.
- **The flat `white/15` border, not the gradient hairline.** The hairline is
  drawn by an inset overlay, which only covers the visible box, so on a modal
  that scrolls it would cover the first screenful and then slide away. The site
  uses the flat border on nearly everything and the hairline on two elements,
  so the flat one is both the safer and the more representative choice.
- **The blur drops from 38px to 8px.** The site uses 4px. Every card in this
  app is glass, and the previous motion pass had to work around how expensive
  that blur is to recompute, so this is a straight win.
- **Typography is not part of this.** The site is Anton and Inter; the app is
  the system stack. The item asks about colour, and matching the fonts means
  bundling roughly 400KB into the installer for something nobody asked for.
- **Dropdowns become a real component.** A native `<select>` popup cannot be
  given a radius, a blur or an animation on any platform, so no amount of CSS
  reaches the ask. The app already has one custom menu, the sidebar brand
  switcher, and the new one is built to look and behave like it.

## The dropdown

`components/Select.tsx`, replacing all 13 native selects.

- Trigger looks exactly like `.field-in` so nothing else has to change.
- Panel is opaque, not glass. Glass over glass is unreadable, which is why the
  brand switcher is already opaque.
- Opens down, flips up when the trigger sits low on screen.
- Keyboard: up, down, home, end, enter, space, escape, and type a letter to
  jump. Closing returns focus to the trigger.
- Click outside closes, matching the brand switcher's `mousedown` listener.
- Motion is a 120ms fade and 4px rise, transform and opacity only, so the
  motion check keeps passing.

## Verification

- All 30 runnable checks, including the motion one that reads the stylesheet.
- Every screen walked in the rebuilt installed app, both to see the palette and
  to open a dropdown on each screen that has one.
