// Each screen group's phone rules (mobile pass). A module of its own so these
// load after styles/mobile.css: a glob in main.tsx is hoisted above every
// other import, which would let the desktop rules win.
import.meta.glob("./*.css", { eager: true });
