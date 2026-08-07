import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import "./KnowledgeSection.css";

/**
 * The files this brand has handed over, and the zone that takes them.
 *
 * These are half the grounding block every AI feature in the app reads; the
 * notes and the niche are the other half. The API only records the drop, and
 * the knowledge worker pulls the words out afterwards, so a fresh row arrives
 * as processing and the list is polled until nothing is being read.
 */

/** The extensions ideas.ts maps to a kind. Anything else would land as "other". */
const ACCEPT = ".pdf,.txt,.md,.mp4,.mov,.webm,.jpg,.jpeg,.png,.webp";

/**
 * What each kind is actually worth to the studio.
 *
 * The list route deliberately withholds the extracted text, so a row cannot
 * report how many words came out of it. What it can report honestly is what
 * was attempted, which is the part that differs by kind: a PDF without a text
 * layer and a file nobody can read both look like every other ready row here.
 */
const CONTRIBUTES: Record<string, string> = {
  pdf: "Its words, when the PDF has a text layer",
  text: "Read word for word",
  video: "The spoken words, transcribed",
  image: "Described in a few sentences, any text on it written out",
  other: "Nothing here can read this one, so the studio never sees it",
};

interface KnowledgeFile {
  id: string;
  name: string;
  /** pdf | text | video | image | other. */
  kind: string;
  /** processing | ready | failed. */
  status: string;
  createdAt: string;
}

/** A file on its way up. Keyed, because the name alone is not unique. */
interface UploadRow {
  key: string;
  name: string;
}

export default function KnowledgeSection({ clientId }: { clientId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<KnowledgeFile[] | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<KnowledgeFile[]>(`/clients/${clientId}/knowledge-files`));
    } catch (err) {
      toast.fail("Could not load the knowledge files", err);
      setRows([]);
    }
  }, [clientId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the worker still has something to read.
  const reading = (rows ?? []).some((r) => r.status === "processing");
  useEffect(() => {
    if (!reading) return;
    let ticks = 0;
    const t = setInterval(() => {
      // Every kind lands on ready or failed, so this normally stops itself.
      // A worker that is not running never moves the row at all, and asking
      // after it until the app closes helps nobody.
      if (++ticks > 75) clearInterval(t);
      else void load();
    }, 4000);
    return () => clearInterval(t);
  }, [reading, load]);

  /** One request per file: the route reads a single part and queues one job. */
  const addFiles = async (files: FileList | File[]) => {
    // Every placeholder goes up before the first request rather than as each
    // file's turn comes round. The uploads run one after another, so building
    // the row inside the loop left everything after the first file with
    // nothing on screen for as long as the earlier ones took, which reads as a
    // drop that did not register and invites dropping the same files again.
    // The index keeps two files of the same name in one batch apart.
    const batch = Array.from(files).map((file, i) => ({
      key: `${file.name}-${Date.now()}-${i}`,
      name: file.name,
      file,
    }));
    setUploads((u) => [...u, ...batch.map(({ key, name }) => ({ key, name }))]);

    for (const { key, file } of batch) {
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const created = await api.postForm<KnowledgeFile>(
          `/clients/${clientId}/knowledge-files`,
          form,
        );
        setRows((cur) => [created, ...(cur ?? [])]);
      } catch (err) {
        // The 413 body is two words, and "file too large" on its own reads as
        // a bug rather than as something the operator can do anything about.
        if (err instanceof ApiError && err.status === 413) {
          toast.error(`${file.name} is too large to drop in. Try the text out of it instead.`);
        } else {
          toast.fail(`Could not add ${file.name}`, err);
        }
      } finally {
        setUploads((u) => u.filter((row) => row.key !== key));
      }
    }
  };

  const remove = async (row: KnowledgeFile) => {
    // The file leaves the disk and the grounding quietly shrinks, so this asks.
    if (!window.confirm(`Remove ${row.name}? The file is deleted and the studio stops reading it.`)) {
      return;
    }
    try {
      await api.del(`/clients/${clientId}/knowledge-files/${row.id}`);
      setRows((cur) => (cur ? cur.filter((r) => r.id !== row.id) : cur));
    } catch (err) {
      toast.fail("Could not remove that file", err);
    }
  };

  return (
    <div className="card glass kbcard">
      <h3>Files the studio reads</h3>
      <div className="sub">
        What you put here is what the studio reads when it writes for this brand. The ideas,
        the scripts, the carousels and the brainstorm all work from the same pile.
      </div>

      <div
        className={`drop kbdrop${dragOver ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInput.current?.click()}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className="ring">
          <svg>
            <use href="#i-up" />
          </svg>
        </div>
        <b>Drop files here, or click to browse</b>
        <p>PDFs, text and markdown, videos and images</p>
      </div>

      {uploads.map((u) => (
        <div className="glass-sm kbup" key={u.key}>
          <div className="kbupname">{u.name}</div>
          <div className="skel kbbar" />
          <div className="sub">Uploading...</div>
        </div>
      ))}

      {rows === null ? (
        <div className="kblist stagger">
          <div className="skel kbskel" />
          <div className="skel kbskel" />
        </div>
      ) : rows.length === 0 ? (
        <div className="empty kbempty">
          <div className="eic">
            <svg>
              <use href="#i-copy" />
            </svg>
          </div>
          <b>Nothing dropped in yet</b>
          <p>Drop the brand's deck, its notes or a video, and the studio starts from it.</p>
        </div>
      ) : (
        <div className="kblist stagger">
          {rows.map((r) => (
            <div className="glass-sm kbrow" key={r.id}>
              <div className="kbmeta">
                <b>{r.name}</b>
                {r.status === "failed" ? (
                  <span className="chip down kberr">Nothing could be read from this one</span>
                ) : (
                  <span className="kbstate">
                    {r.status === "processing"
                      ? "Reading it..."
                      : (CONTRIBUTES[r.kind] ?? CONTRIBUTES.other)}
                  </span>
                )}
              </div>
              <span className="chip flat kbkind">{r.kind}</span>
              <button className="dangerbtn kbdel" onClick={() => void remove(r)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
