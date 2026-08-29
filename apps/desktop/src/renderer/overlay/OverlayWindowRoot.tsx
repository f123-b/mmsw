import type { JSX } from "react";
import { ContentOverlayRoot } from "./ContentOverlayRoot";
import { ControlOverlayRoot } from "./ControlOverlayRoot";
import type { OverlayRootProps } from "./OverlayRoot";

/** Selects a native surface without sharing an all-purpose OverlayRoot tree. */
export function OverlayWindowRoot(props: OverlayRootProps): JSX.Element {
  return props.surface === "control" ? <ControlOverlayRoot {...props} /> : <ContentOverlayRoot {...props} />;
}
