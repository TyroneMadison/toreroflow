interface Kpi {
  label: string;
  value: string;
  delta: string;
  down?: boolean;
  sparkStroke: string;
  sparkPoints: string;
}

const KPIS: Kpi[] = [
  {
    label: "Total views",
    value: "2.41M",
    delta: "34%",
    sparkStroke: "#4ea8ff",
    sparkPoints: "0,20 12,18 24,19 36,12 48,14 60,6 74,3",
  },
  {
    label: "Reach",
    value: "1.08M",
    delta: "21%",
    sparkStroke: "#8b7bff",
    sparkPoints: "0,18 12,20 24,14 36,15 48,9 60,10 74,5",
  },
  {
    label: "Engagement rate",
    value: "7.9%",
    delta: "1.4pt",
    sparkStroke: "#4ea8ff",
    sparkPoints: "0,16 12,14 24,17 36,11 48,12 60,8 74,6",
  },
  {
    label: "Followers gained",
    value: "+18.6K",
    delta: "52%",
    sparkStroke: "#8b7bff",
    sparkPoints: "0,22 12,19 24,16 36,15 48,10 60,7 74,3",
  },
  {
    label: "Avg watch time",
    value: "14.2s",
    delta: "3%",
    down: true,
    sparkStroke: "#6f7ba0",
    sparkPoints: "0,8 12,10 24,9 36,12 48,11 60,14 74,13",
  },
];

const DONUT_LEGEND = [
  { color: "#d62976", label: "Instagram", share: "38%" },
  { color: "#25f4ee", label: "TikTok", share: "31%" },
  { color: "#ff4237", label: "YouTube", share: "22%" },
  { color: "#ffe600", label: "Snapchat", share: "9%" },
];

const REACH_BARS = [
  { value: "412K", height: "78%", background: "linear-gradient(180deg,#8b7bff,#5a48c0)", label: "IG" },
  { value: "336K", height: "64%", background: "linear-gradient(180deg,#5e9bff,#3f6fd0)", label: "TikTok" },
  { value: "238K", height: "46%", background: "linear-gradient(180deg,#4ea8ff,#3579c0)", label: "YT" },
  { value: "96K", height: "20%", background: "linear-gradient(180deg,#7a86c0,#525d90)", label: "Snap" },
];

export default function AnalyticsScreen() {
  return (
    <section className="screen active" data-screen="analytics">
      <div className="topbar">
        <div className="h">
          <h2>Client Analytics</h2>
          <p>Halo Fitness, last 30 days across all platforms.</p>
        </div>
        <div className="client-pill glass-sm" style={{ padding: "8px 12px" }}>
          <div
            className="avatar"
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              fontSize: 11,
              background: "linear-gradient(135deg,#8b7bff,#4ea8ff)",
            }}
          >
            HF
          </div>
          <div className="meta">
            <b style={{ fontSize: 12.5 }}>Halo Fitness</b>
          </div>
          <div className="chev">
            <svg>
              <use href="#i-chev" />
            </svg>
          </div>
        </div>
        <button className="btn">
          <svg>
            <use href="#i-dl" />
          </svg>{" "}
          Export report
        </button>
      </div>
      <div className="stage">
        <div className="kpis">
          {KPIS.map((kpi) => (
            <div key={kpi.label} className="kpi glass">
              <div className="lab">{kpi.label}</div>
              <div className="val">{kpi.value}</div>
              <div className="foot">
                <span className={`delta ${kpi.down ? "dn" : "up"}`}>
                  <svg style={kpi.down ? { transform: "rotate(180deg)" } : undefined}>
                    <use href="#i-up" />
                  </svg>{" "}
                  {kpi.delta}
                </span>
                <svg className="spark" viewBox="0 0 74 26">
                  <polyline
                    fill="none"
                    stroke={kpi.sparkStroke}
                    strokeWidth="2"
                    points={kpi.sparkPoints}
                  />
                </svg>
              </div>
            </div>
          ))}
        </div>

        <div className="chartcard glass">
          <div className="rowhead">
            <div>
              <h3>Views over time</h3>
              <div className="sub">Daily views, all platforms combined</div>
            </div>
            <div className="legend">
              <div className="li">
                <span className="d" style={{ background: "#4ea8ff" }} /> Views
              </div>
              <div className="li" style={{ color: "var(--txt-3)" }}>
                <span className="d" style={{ background: "rgba(255,255,255,.22)" }} /> Prev period
              </div>
            </div>
          </div>
          <svg className="chart" viewBox="0 0 720 230" preserveAspectRatio="none">
            <defs>
              <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4ea8ff" stopOpacity="0.4" />
                <stop offset="1" stopColor="#4ea8ff" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#8b7bff" />
                <stop offset="1" stopColor="#4ea8ff" />
              </linearGradient>
            </defs>
            <line className="gridline" x1="0" y1="40" x2="720" y2="40" />
            <line className="gridline" x1="0" y1="100" x2="720" y2="100" />
            <line className="gridline" x1="0" y1="160" x2="720" y2="160" />
            <polyline
              fill="none"
              stroke="rgba(255,255,255,.2)"
              strokeWidth="2"
              strokeDasharray="4 5"
              points="0,150 72,140 144,150 216,120 288,128 360,104 432,110 504,96 576,102 648,88 720,84"
            />
            <path
              d="M0,178 L72,158 L144,168 L216,132 L288,142 L360,104 L432,116 L504,82 L576,96 L648,58 L720,46 L720,230 L0,230 Z"
              fill="url(#area)"
            />
            <polyline
              fill="none"
              stroke="url(#line)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              points="0,178 72,158 144,168 216,132 288,142 360,104 432,116 504,82 576,96 648,58 720,46"
            />
            <circle cx="720" cy="46" r="5" fill="#4ea8ff" />
            <circle cx="720" cy="46" r="10" fill="#4ea8ff" opacity="0.25" />
            <circle cx="504" cy="82" r="4" fill="#8b7bff" />
          </svg>
        </div>

        <div className="two">
          <div className="card glass">
            <h3>Platform mix</h3>
            <div className="sub" style={{ marginBottom: 14 }}>
              Share of total views
            </div>
            <div className="donutwrap">
              <svg width="130" height="130" viewBox="0 0 130 130">
                <g transform="rotate(-90 65 65)" fill="none" strokeWidth="16">
                  <circle cx="65" cy="65" r="54" stroke="rgba(255,255,255,.06)" />
                  <circle
                    cx="65"
                    cy="65"
                    r="54"
                    stroke="#d62976"
                    strokeDasharray="129 210"
                    strokeDashoffset="0"
                  />
                  <circle
                    cx="65"
                    cy="65"
                    r="54"
                    stroke="#25f4ee"
                    strokeDasharray="105 234"
                    strokeDashoffset="-129"
                  />
                  <circle
                    cx="65"
                    cy="65"
                    r="54"
                    stroke="#ff4237"
                    strokeDasharray="75 264"
                    strokeDashoffset="-234"
                  />
                  <circle
                    cx="65"
                    cy="65"
                    r="54"
                    stroke="#ffe600"
                    strokeDasharray="30 309"
                    strokeDashoffset="-309"
                  />
                </g>
                <text
                  x="65"
                  y="61"
                  textAnchor="middle"
                  fill="#fff"
                  fontSize="20"
                  fontWeight="700"
                  fontFamily="sans-serif"
                >
                  2.4M
                </text>
                <text
                  x="65"
                  y="78"
                  textAnchor="middle"
                  fill="rgba(255,255,255,.5)"
                  fontSize="10"
                  fontFamily="sans-serif"
                >
                  views
                </text>
              </svg>
              <div className="dleg">
                {DONUT_LEGEND.map((row) => (
                  <div key={row.label} className="row">
                    <span className="d" style={{ background: row.color }} /> {row.label}{" "}
                    <b>{row.share}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="card glass">
            <h3>Reach by platform</h3>
            <div className="sub" style={{ marginBottom: 6 }}>
              Accounts reached, last 30 days
            </div>
            <div className="bars">
              {REACH_BARS.map((bar) => (
                <div key={bar.label} className="bar">
                  <div className="bv">{bar.value}</div>
                  <div className="fill" style={{ height: bar.height, background: bar.background }} />
                  <div className="bl">{bar.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="note">
          Report auto refreshes daily. Export as branded PDF or shareable client link.
        </div>
      </div>
    </section>
  );
}
