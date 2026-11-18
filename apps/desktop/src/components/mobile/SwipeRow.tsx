import type { ReactNode } from "react";
import { useLongPress, useSwipeLeft } from "./gestures";

/**
 * A row or card that can be swiped left (and optionally long-pressed) on the
 * phone. The visible buttons inside keep working for a mouse or a keyboard.
 */
export default function SwipeRow({
  onLeft,
  onLong,
  className,
  children,
  testId,
}: {
  onLeft?: () => void;
  onLong?: () => void;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const swipe = useSwipeLeft(onLeft ?? (() => {}));
  const press = useLongPress(onLong ?? (() => {}));
  return (
    <div
      className={className}
      style={{ touchAction: "pan-y" }}
      data-testid={testId}
      onPointerDown={(e) => {
        if (onLeft) swipe.onPointerDown(e);
        if (onLong) press.onPointerDown(e);
      }}
      onPointerMove={(e) => {
        if (onLeft) swipe.onPointerMove(e);
        if (onLong) press.onPointerMove(e);
      }}
      onPointerUp={() => {
        swipe.onPointerUp();
        press.onPointerUp();
      }}
      onPointerCancel={() => {
        swipe.onPointerCancel();
        press.onPointerCancel();
      }}
      onContextMenu={onLong ? (e) => e.preventDefault() : undefined}
    >
      {children}
    </div>
  );
}
