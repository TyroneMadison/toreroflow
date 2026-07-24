import { useState } from "react";
import Modal from "./Modal";
import Pf, { type PlatformId } from "../components/Pf";

interface ComposerModalProps {
  onClose: () => void;
}

const STYLE_TAGS = ["Bold pop", "Karaoke", "Minimal", "Neon"] as const;

const PLATFORM_TABS: Array<{ p: PlatformId; label: string }> = [
  { p: "ig", label: "Reels" },
  { p: "tt", label: "TikTok" },
  { p: "yt", label: "Shorts" },
  { p: "sc", label: "Spotlight" },
];

const HASHTAGS = ["#posture", "#mobility", "#formcheck", "#fittok", "#halofitness"];

const SCHED_OPTIONS: Array<{ title: string; desc: string }> = [
  { title: "Best time", desc: "Tomorrow, 6:40 PM" },
  { title: "Custom", desc: "Pick date and time" },
  { title: "Add to queue", desc: "Next open slot" },
];

export default function ComposerModal({ onClose }: ComposerModalProps) {
  const [styleIdx, setStyleIdx] = useState(0);
  const [tabIdx, setTabIdx] = useState(0);
  const [schedIdx, setSchedIdx] = useState(0);

  return (
    <Modal maxWidth={900} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Compose post</h3>
          <p>posture-reset-final.mp4 for Halo Fitness</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <div className="composer">
          <div>
            <div className="cpreview">
              <div className="reframe">
                <svg
                  style={{ width: 12, height: 12, stroke: "#fff", fill: "none", strokeWidth: 2 }}
                  viewBox="0 0 24 24"
                >
                  <use href="#i-crop" />
                </svg>{" "}
                9:16 auto
              </div>
              <div className="cap">
                <i>Three moves to</i> <i className="on">fix your posture</i> <i>in 60s</i>
              </div>
              <div className="pbar">
                <i />
              </div>
            </div>
            <label className="flabel" style={{ marginTop: 14 }}>
              Caption style
            </label>
            <div className="styles">
              {STYLE_TAGS.map((tag, i) => (
                <span
                  key={tag}
                  className={`styletag${i === styleIdx ? " on" : ""}`}
                  onClick={() => setStyleIdx(i)}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <div>
            <label className="flabel">Platform</label>
            <div className="ptabs">
              {PLATFORM_TABS.map((tab, i) => (
                <div
                  key={tab.p}
                  className={`ptab${i === tabIdx ? " on" : ""}`}
                  onClick={() => setTabIdx(i)}
                >
                  <Pf p={tab.p} size="sm" /> {tab.label}
                </div>
              ))}
            </div>
            <label className="flabel">Caption</label>
            <div className="captionbox">
              <textarea defaultValue="Three moves to fix your posture in under a minute. Which one are you trying first?" />
              <button className="aigen">
                <svg>
                  <use href="#i-bolt" />
                </svg>{" "}
                Write with Claude
              </button>
            </div>
            <div className="hashrow">
              {HASHTAGS.map((tag) => (
                <span key={tag} className="hash">
                  {tag}
                </span>
              ))}
            </div>
            <label className="flabel" style={{ marginTop: 18 }}>
              Schedule
            </label>
            <div className="schedgrid">
              {SCHED_OPTIONS.map((opt, i) => (
                <div
                  key={opt.title}
                  className={`schedopt${i === schedIdx ? " on" : ""}`}
                  onClick={() => setSchedIdx(i)}
                >
                  <b>{opt.title}</b>
                  <span>{opt.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Save draft
        </button>
        <button className="btn" onClick={onClose}>
          <svg>
            <use href="#i-bolt" />
          </svg>{" "}
          Schedule post
        </button>
      </div>
    </Modal>
  );
}
