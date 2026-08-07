import { useCallback, useEffect, useRef, useState } from "react";
import type { EditDoc } from "@toreroflow/core";
import { api } from "../lib/api";

export type SaveState = "saving" | "saved";

const UNDO_CAP = 100;
const SAVE_DEBOUNCE_MS = 800;
const RETRY_MS = 3000;

/**
 * The edit document's state: immutable updates, bounded undo and redo, and a
 * debounced PATCH autosave. The doc in memory is the truth; the server only
 * ever receives the whole thing.
 */
export function useEditDoc(projectId: string, initial: EditDoc) {
  const [doc, setDoc] = useState<EditDoc>(initial);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const docRef = useRef(doc);
  const undoStack = useRef<EditDoc[]>([]);
  const redoStack = useRef<EditDoc[]>([]);
  /** True while a change is waiting for the timer or riding a request. */
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  const schedule = useCallback(
    (delay: number = SAVE_DEBOUNCE_MS) => {
      dirty.current = true;
      setSaveState("saving");
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        dirty.current = false;
        api
          .patch(`/edit-projects/${projectId}`, { doc: docRef.current })
          .then(() => {
            // A change made while the request was in flight keeps "saving".
            if (!dirty.current && timer.current === null) setSaveState("saved");
          })
          .catch(() => schedule(RETRY_MS));
      }, delay);
    },
    [projectId],
  );

  const update = useCallback(
    (fn: (d: EditDoc) => EditDoc) => {
      const prev = docRef.current;
      const next = fn(prev);
      if (next === prev) return;
      undoStack.current.push(prev);
      if (undoStack.current.length > UNDO_CAP) undoStack.current.shift();
      redoStack.current = [];
      docRef.current = next;
      setDoc(next);
      schedule();
    },
    [schedule],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docRef.current);
    docRef.current = prev;
    setDoc(prev);
    schedule();
  }, [schedule]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docRef.current);
    docRef.current = next;
    setDoc(next);
    schedule();
  }, [schedule]);

  // Flush on unmount: a pending debounce becomes an immediate fire-and-forget
  // save, so closing the editor never loses the last edit.
  useEffect(
    () => () => {
      if (timer.current !== null || dirty.current) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        void api.patch(`/edit-projects/${projectId}`, { doc: docRef.current }).catch(() => {});
      }
    },
    [projectId],
  );

  return {
    doc,
    update,
    undo,
    redo,
    // Re-renders happen exactly when the stacks change (every path calls
    // setDoc), so reading the refs during render stays in step.
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    saveState,
  };
}
