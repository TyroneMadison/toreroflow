/*
 * UI check: `pnpm --filter @toreroflow/desktop test`.
 * Renders the shared marks to HTML and reads what a screen reader would.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, KillSwitch, Switch } from "./IdeaBits";

function has(html: string, part: string, message: string) {
  if (!html.includes(part)) throw new Error(`${message}\n  missing ${part}\n  in ${html}`);
}
function lacks(html: string, part: string, message: string) {
  if (html.includes(part)) throw new Error(`${message}\n  found ${part}\n  in ${html}`);
}

const off = renderToStaticMarkup(<KillSwitch on={false} />);
has(off, 'role="switch"', "the kill switch is a switch");
has(off, 'aria-checked="false"', "the kill switch reads OFF");
has(off, "disabled", "the kill switch cannot be flipped from the app");
has(off, ">OFF<", "OFF is visible, not just announced");
has(off, "never emailed", "OFF says what it means");

const on = renderToStaticMarkup(<KillSwitch on />);
has(on, 'aria-checked="true"', "a server-side ON still shows as ON");

const live = renderToStaticMarkup(<Switch on={false} label="Generation" onChange={() => {}} />);
lacks(live, "disabled", "a switch with a handler can be pressed");
has(live, 'aria-label="Generation"', "a switch carries its name");

has(renderToStaticMarkup(<Badge tone="ok">Fixed</Badge>), 'class="id-badge ok"', "badge tone");

console.log("ideaBits: all checks passed");
