/**
 * Placeholder data for the dev-only Ideas demo (?demo=coral). Invented brands
 * and creator handles only (Acme Motors, Northside Rentals, Lakeview Auto,
 * Studio Demo). Never imported by a production build.
 */

type Need = { type: string; label: string };
const need = (type: string, label: string): Need => ({ type, label });
const CAR_LOT = need("location", "Needs a car lot");
const TWO = need("people", "Needs two people");
const LAPTOP = need("prop", "Needs a laptop");
const RING = need("prop", "Needs a ring light");
const GIMBAL = need("prop", "Needs a gimbal");

export interface DemoShot { title: string; framing: string; angle: string; move: string; pose: string; time: string; sign?: string }

const SHOTS: DemoShot[] = [
  { title: "Close up, eye level, talk to camera", framing: "close-up", angle: "eye", move: "push", pose: "talk", time: "0:00-0:03" },
  { title: "Wide, low angle, point at the fees sign", framing: "wide", angle: "low", move: "tilt", pose: "point", time: "0:03-0:08", sign: "FEES $89" },
  { title: "Over the shoulder, booking screen, pan", framing: "over-the-shoulder", angle: "eye", move: "pan", pose: "hold", time: "0:08-0:15", sign: "SAVE 40%" },
];

const script = (s: string[]) => `HOOK: ${s[0]}\nSETUP: ${s[1]}\nPAYOFF: ${s[2]}\nCTA: ${s[3]}`;
const gifs = (id: string) => [
  { kind: "hook", key: `demo-${id}-hook`, caption: "Say this · Hook: medium close-up, captions on" },
  ...SHOTS.map((s, i) => ({ kind: "shot", key: `demo-${id}-s${i + 1}`, caption: `Shot ${i + 1} · ${s.title} · ${s.time}` })),
];

const base = { niche: "Car rentals in Lakeview", status: "idea", source: "analysis", createdAt: "2026-10-16T14:00:00.000Z", updatedAt: "2026-10-16T18:00:00.000Z" };

export const DEMO_SAVED = [
  { id: "s1", creator: "@lotlifejay", funnelStage: "middle", difficulty: "medium", formatName: "Comparison",
    text: "Weekend rate vs airport counter: the real price, side by side",
    needs: [TWO, LAPTOP, RING],
    sc: ["Same car, same weekend. One price is almost double. Here is why.", "Split screen: our booking page on the left, the airport quote on the right.", "Circle the fees one by one. Taxes, the counter fee, the fuel charge.", "Save this before your next trip."],
    why: "People already shopping for a rental compare prices anyway, so a side by side does the math for them and earns the save.", completed: false },
  { id: "s2", creator: "@drivewithdana", funnelStage: "top", difficulty: "easy", formatName: "Talking head POV",
    text: "3 things nobody tells you before your first car rental",
    needs: [CAR_LOT],
    sc: ["Stop. Before you rent a car this weekend, check these three things.", "Walk the car slowly, point at the tires, the fuel gauge and the mileage.", "Number three saves most people fifty dollars at drop off.", "Comment \"CHECK\" and I will send you the full list."],
    why: "First-time renters are anxious, and a numbered promise in the first second keeps them watching to number three.", completed: false },
  { id: "s3", creator: "@rentsmartkai", funnelStage: "bottom", difficulty: "hard", formatName: "This is your sign",
    text: "Only 4 cars left for Friday. Book this week, get the upgrade free",
    needs: [CAR_LOT, TWO, GIMBAL, need("prop", "Needs sunset light")],
    sc: ["Only four cars left for Friday, and the upgrade is on us this week.", "Pan across the lot, stop on the last SUV with the keys in hand.", "Show the booking screen and the upgrade line on the receipt.", "Tap the link in bio and lock yours in before Thursday."],
    why: "Real scarcity plus a free upgrade gives viewers who were already close to booking a reason to do it today.", completed: false },
  { id: "s4", creator: "@keysandmiles", funnelStage: "middle", difficulty: "medium", formatName: "Reaction",
    text: "We read our harshest review out loud",
    needs: [RING],
    sc: ["We read our harshest review on camera.", "Read the review slowly, then look up at the camera.", "Show what we changed the very next week.", "Tell us what we should fix next."],
    why: "Owning a bad review is disarming and makes the good ones believable.", completed: true },
  { id: "s5", creator: "@roadtripreese", funnelStage: "top", difficulty: "easy", formatName: "Wait for it",
    text: "Guess the rental price of this car",
    needs: [],
    sc: ["Comment your guess before the reveal.", "Slow walk around the car, keys in hand.", "The price card drops in the last second.", "Follow for the next guess."],
    why: "A guessing game turns viewers into commenters in the first second.", completed: false },
].map(({ sc, why, ...r }) => ({ ...base, ...r, hook: r.text, scriptText: script(sc), whyItWorks: why, gifs: gifs(r.id), shots: SHOTS }));

type Row = [string, string, string, string, Need[], string, string, string];
const GEN: Row[] = [
  ["@rentsmartkai", "top", "easy", "The one question every renter forgets to ask", [], "Ask this at pickup and you will never pay a surprise fee.", "A promise to avoid a loss stops the scroll faster than a tip.", "Talking head POV"],
  ["@rentsmartkai", "middle", "medium", "Compact vs SUV: which one fits a family trip", [TWO, CAR_LOT], "We packed both with the same luggage. Only one closed.", "Families compare sizes before booking, so the test answers their real question.", "Comparison"],
  ["@rentsmartkai", "bottom", "easy", "Last minute weekend deal, 2 cars left", [CAR_LOT], "Two cars left for Saturday. This is the cheaper one.", "A real, countable shortage turns browsers into bookers.", "This is your sign"],
  ["@rentsmartkai", "top", "easy", "What a rental pickup looks like in 20 seconds", [], "Keys to driveway in twenty seconds. Watch.", "Speed is the whole story, and the timer keeps people to the end.", "Day in the life"],
  ["@rentsmartkai", "middle", "medium", "Ranking our 5 cars from worst to best for road trips", [CAR_LOT, GIMBAL], "Number one surprised even our team.", "Rankings invite debate in the comments, which pushes reach.", "Ranking"],
  ["@rentsmartkai", "top", "hard", "When the customer returns the car spotless", [TWO, CAR_LOT, need("prop", "Needs props")], "Tell me you rent cars without telling me you rent cars.", "Inside jokes travel fast with people who have rented before.", "Tell me without telling me"],
  ["@rentsmartkai", "bottom", "medium", "Is the deposit refundable? The honest answer", [LAPTOP], "Yes, and here is exactly when you get it back.", "It removes the last doubt that stops a booking.", "Educational"],
  ["@rentsmartkai", "middle", "easy", "What you expect at pickup vs what actually happens", [], "You expect a line. Here is what pickup looks like with us.", "The contrast shows the benefit without saying it.", "Expectation vs reality"],
  ["@rentsmartkai", "top", "medium", "I tried to return a car in under 60 seconds", [CAR_LOT, need("prop", "Needs a timer app")], "Sixty seconds, one car, no help. Go.", "A clear rule and a clock make a simple challenge feel high stakes.", "Challenge"],
  ["@rentsmartkai", "bottom", "hard", "Watch the price load for your next trip", [LAPTOP, need("prop", "Needs a screen recorder"), RING], "Watch the weekend total load. Then watch ours.", "The slow reveal makes the savings land at the exact moment of decision.", "Loading reveal"],
];
const SUP: Row[] = [
  ["@drivewithdana", "top", "easy", "Day in the life of a rental lot", [CAR_LOT], "6 AM, 40 cars, one person. Here is how it goes.", "Behind-the-scenes routines build trust with people who have never heard of you.", "Day in the life"],
  ["@lotlifejay", "middle", "medium", "How we clean every car between trips", [CAR_LOT, GIMBAL], "This is the step most rental companies skip.", "Showing the process answers the cleanliness worry before it is asked.", "Educational"],
  ["@rentsmartkai", "bottom", "easy", "First booking discount, this week only", [], "If you have never rented with us, watch to the end.", "A deadline plus a first-timer offer gives a clear reason to act.", "This is your sign"],
  ["@keysandmiles", "middle", "medium", "Customer review read out loud", [RING], "We read our harshest review on camera.", "Owning a bad review is disarming and makes the good ones believable.", "Reaction"],
  ["@roadtripreese", "top", "easy", "Guess the rental price of this car", [], "Comment your guess before the reveal.", "A guessing game turns viewers into commenters in the first second.", "Wait for it"],
  ["@counterclarke", "bottom", "medium", "Reserve now, pay at pickup", [LAPTOP], "No card needed today. Here is how it works.", "It removes the payment worry for people ready to book.", "Educational"],
  ["@mileagemaya", "top", "hard", "When the GPS says turn left into a lake", [TWO, CAR_LOT, need("prop", "Needs props")], "Me trusting the rental GPS one more time.", "Relatable travel chaos is built for shares.", "Skits"],
  ["@pickupandre", "middle", "easy", "Airport pickup vs downtown pickup", [], "Same car. One pickup takes 40 minutes longer.", "Travelers planning a trip want the faster option spelled out.", "Comparison"],
  ["@fleetfaith", "top", "easy", "Unpopular opinion: the compact is the best rental", [], "Hot take: you do not need the SUV.", "A bold opinion invites people to argue in the comments.", "Unpopular opinion"],
  ["@weekendwheelz", "bottom", "medium", "Ranking add-ons you should actually pay for", [LAPTOP], "Only one of these add-ons is worth the money.", "Buyers at checkout want a short, trusted answer.", "Ranking"],
  ["@dropoffdev", "middle", "hard", "The car before and after a family road trip", [CAR_LOT, TWO, GIMBAL], "This is what 900 miles with three kids looks like.", "The reveal is satisfying and shows the cleaning promise.", "Before and after"],
  ["@shuttlesam", "top", "medium", "Rental counter expectations vs reality", [TWO], "What you think the counter is like. What it is like.", "Shared frustration earns recognition and shares.", "Expectation vs reality"],
  ["@upgradeuche", "bottom", "easy", "Your weekend car is loading", [], "Your upgrade is loading. 3, 2, 1.", "The countdown lands the offer at the peak of attention.", "Loading reveal"],
  ["@lanechangelex", "middle", "easy", "5 things to check before you drive off", [], "Number four costs people the most.", "Numbered tips are easy to save and come back to.", "Faceless listicle"],
  ["@fullfueltola", "top", "medium", "Fill the tank challenge: exact to the line", [CAR_LOT, need("prop", "Needs a timer app")], "Can I return it at exactly full? Watch.", "A tiny challenge with a clear finish line keeps people watching.", "Challenge"],
  ["@drivewithdana", "middle", "easy", "The real cost of a one week rental", [LAPTOP], "Here is every line on a seven day receipt.", "Transparency on price helps viewers who are comparing.", "Talking head POV"],
  ["@lotlifejay", "top", "easy", "Tell me you work at a rental lot", [CAR_LOT], "Tell me you work at a rental lot without telling me.", "Insider humor travels fast and builds a following.", "Tell me without telling me"],
  ["@rentsmartkai", "middle", "medium", "How we handle a flat tire on a rental", [CAR_LOT, GIMBAL], "Here is what happens when you call us at midnight.", "Showing support in action answers the scariest what-if.", "Storytelling"],
  ["@keysandmiles", "bottom", "hard", "This is your sign to book the road trip", [CAR_LOT, need("prop", "Needs sunset light"), need("prop", "Needs a drone")], "This is your sign to finally take the trip.", "A warm nudge reaches people who have been putting it off.", "This is your sign"],
  ["@roadtripreese", "top", "easy", "Reacting to the worst rental horror stories", [RING], "Okay, this one is actually our fault.", "Reactions borrow attention from stories people already love.", "Reaction"],
];

const toIdea = ([creator, funnelStage, difficulty, text, needs, hook, whyItWorks, format]: Row) => ({
  text, label: "Numbered promise", format, funnelStage, difficulty, needs, whyItWorks, creator,
  script: `HOOK: ${hook}\nSETUP: Show the setup.\nPAYOFF: Land the payoff.\nCTA: Save this.`, shots: [],
});

const HANDLES = [...new Set(SUP.map((r) => r[0]))];
const run = (single: boolean) => ({
  id: single ? "run-single" : "run-super",
  status: "ready",
  creators: (single ? ["@rentsmartkai"] : HANDLES).map((h) => ({
    url: `https://www.youtube.com/${h}`, handle: h, platform: "youtube", status: "done", videos: 38, note: "",
  })),
  ideas: (single ? GEN : SUP).map(toIdea),
  capCents: 200, spentCents: 46, error: null, createdAt: "2026-10-18T10:00:00.000Z",
});
export const DEMO_RUN = run;
export const DEMO_CREATORS = HANDLES.map((h) => `https://www.youtube.com/${h}`);

export const DEMO_REMIX = [
  ["Skits", "top", "medium", "Two renters, one weekend, very different bills", [TWO, CAR_LOT], "You paid how much at the airport? Same car as mine.", "A two-person scene makes the price gap feel personal and funny, which reaches new viewers.", "New hook, new format"],
  ["Ranking", "middle", "easy", "Ranking 5 rental fees from sneaky to fair", [LAPTOP], "Fee number one on this list should not be legal.", "Ranking the fees keeps the comparison, but gives people a reason to argue and save.", "New hook, new format"],
  ["Loading reveal", "bottom", "easy", "Watch the airport total load, then watch ours", [], "Watch the airport total load. Then watch ours.", "The slow reveal lands the savings right when a viewer is deciding where to book.", "New format, sharper hook"],
].map(([format, funnelStage, difficulty, text, needs, hook, whyItWorks, label]) => ({
  text, label, format, funnelStage, difficulty, needs, whyItWorks, creator: "@lotlifejay",
  script: `HOOK: ${hook as string}\nSETUP: Show it.\nPAYOFF: Land it.\nCTA: Save this.`, shots: [],
}));
