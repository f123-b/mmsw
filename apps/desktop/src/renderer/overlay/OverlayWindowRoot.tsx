import type { JSX } from "react";
import { ControlOverlayRoot } from "./ControlOverlayRoot";
import { TransientOverlayRoot } from "./TransientOverlayRoot";
import { OverlayRoot, type OverlayRootProps } from "./OverlayRoot";

/** Selects a native surface without sharing an all-purpose OverlayRoot tree. */
export function OverlayWindowRoot(props: OverlayRootProps): JSX.Element {
  if (props.surface === "control") return <ControlOverlayRoot {...props} />;
  if (props.surface === "transient") return <TransientOverlayRoot {...props} />;
  return <OverlayRoot {...props} />;
}
