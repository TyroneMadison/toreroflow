import Pf, { type PlatformId } from "../components/Pf";

interface AccountsScreenProps {
  onOpenConnect: () => void;
}

interface ClientCard {
  initials: string;
  gradient: string;
  name: string;
  plan: string;
  platforms: PlatformId[];
  followers: string;
  delta: string;
  health: "ok" | "warn";
  healthText: string;
}

const CLIENTS: ClientCard[] = [
  {
    initials: "HF",
    gradient: "linear-gradient(135deg,#8b7bff,#4ea8ff)",
    name: "Halo Fitness",
    plan: "Growth plan, 4 profiles",
    platforms: ["ig", "tt", "yt", "sc"],
    followers: "248K",
    delta: "8.1%",
    health: "ok",
    healthText: "All connected",
  },
  {
    initials: "NS",
    gradient: "linear-gradient(135deg,#a07bff,#6a5bff)",
    name: "Nova Skincare",
    plan: "Growth plan, 3 profiles",
    platforms: ["ig", "tt", "yt"],
    followers: "173K",
    delta: "12%",
    health: "ok",
    healthText: "All connected",
  },
  {
    initials: "AA",
    gradient: "linear-gradient(135deg,#4ea8ff,#6a5bff)",
    name: "Apex Athletics",
    plan: "Scale plan, 4 profiles",
    platforms: ["ig", "tt", "yt", "sc"],
    followers: "521K",
    delta: "5.4%",
    health: "warn",
    healthText: "TikTok needs reconnect",
  },
  {
    initials: "BC",
    gradient: "linear-gradient(135deg,#6a5bff,#4ea8ff)",
    name: "Bloom Cafe",
    plan: "Starter plan, 2 profiles",
    platforms: ["ig", "tt"],
    followers: "64K",
    delta: "19%",
    health: "ok",
    healthText: "All connected",
  },
  {
    initials: "VM",
    gradient: "linear-gradient(135deg,#8b7bff,#5e9bff)",
    name: "Vertex Media",
    plan: "Scale plan, 4 profiles",
    platforms: ["ig", "tt", "yt", "sc"],
    followers: "389K",
    delta: "6.8%",
    health: "ok",
    healthText: "All connected",
  },
];

export default function AccountsScreen({ onOpenConnect }: AccountsScreenProps) {
  return (
    <section className="screen active" data-screen="accounts">
      <div className="topbar">
        <div className="h">
          <h2>Accounts</h2>
          <p>5 clients, 17 connected profiles across 4 platforms.</p>
        </div>
        <div className="search">
          <svg>
            <use href="#i-search" />
          </svg>{" "}
          Find client
        </div>
        <button className="btn" onClick={onOpenConnect}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          Add client
        </button>
      </div>
      <div className="stage">
        <div className="clients">
          {CLIENTS.map((client) => (
            <div key={client.name} className="cc glass">
              <div className="top">
                <div
                  className="avatar lg"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 13,
                    fontSize: 15,
                    background: client.gradient,
                  }}
                >
                  {client.initials}
                </div>
                <div className="meta">
                  <b>{client.name}</b>
                  <span>{client.plan}</span>
                </div>
              </div>
              <div className="plat">
                {client.platforms.map((p) => (
                  <Pf key={p} p={p} />
                ))}
              </div>
              <div className="stat">
                <div>
                  <div className="big">{client.followers}</div>
                  <div className="lab">total followers</div>
                </div>
                <span className="delta up">
                  <svg>
                    <use href="#i-up" />
                  </svg>{" "}
                  {client.delta}
                </span>
              </div>
              <div className={`health ${client.health}`}>
                <span className="d" /> {client.healthText}
              </div>
            </div>
          ))}
          <div className="add-cc" onClick={onOpenConnect}>
            <div className="plus">
              <svg>
                <use href="#i-plus" />
              </svg>
            </div>
            <div style={{ textAlign: "center" }}>
              <b style={{ fontSize: 14 }}>Add a new client</b>
              <div style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 3 }}>
                Connect Instagram, TikTok, YouTube, Snapchat
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
