import Modal from "./Modal";

interface PreviewModalProps {
  name: string;
  url: string;
  onClose: () => void;
}

/** Plays the actual dropped video file from its object URL. */
export default function PreviewModal({ name, url, onClose }: PreviewModalProps) {
  return (
    <Modal maxWidth={720} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Preview</h3>
          <p>{name}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <video className="previewvid" src={url} controls autoPlay />
      </div>
    </Modal>
  );
}
