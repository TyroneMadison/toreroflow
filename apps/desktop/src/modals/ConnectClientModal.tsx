import Modal from "./Modal";
import Pf, { type PlatformId } from "../components/Pf";

interface ConnectClientModalProps {
  onClose: () => void;
}

interface ConnectRow {
  p: PlatformId;
  name: string;
  desc: string;
  connected: boolean;
}

const CONNECT_ROWS: ConnectRow[] = [
  { p: "ig", name: "Instagram", desc: "Reels and posts", connected: true },
  { p: "tt", name: "TikTok", desc: "Direct post", connected: false },
  { p: "yt", name: "YouTube", desc: "Shorts and video", connected: true },
  { p: "sc", name: "Snapchat", desc: "Spotlight and stories", connected: false },
];

export default function ConnectClientModal({ onClose }: ConnectClientModalProps) {
  return (
    <Modal maxWidth={440} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Add a client</h3>
          <p>Name the client and connect their platforms.</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <label className="flabel">Client name</label>
        <input className="field-in" placeholder="e.g. Bella Napoli" />
        <label className="flabel" style={{ marginTop: 18 }}>
          Connect platforms
        </label>
        {CONNECT_ROWS.map((row) => (
          <div key={row.p} className="connect-row">
            <Pf p={row.p} />
            <div className="cinfo">
              <b>{row.name}</b>
              <span>{row.desc}</span>
            </div>
            {row.connected ? (
              <button className="cbtn done">
                <svg>
                  <use href="#i-check" />
                </svg>{" "}
                Connected
              </button>
            ) : (
              <button className="cbtn">Connect</button>
            )}
          </div>
        ))}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={onClose}>
          Create client
        </button>
      </div>
    </Modal>
  );
}
