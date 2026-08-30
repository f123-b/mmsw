import type { JSX } from "react";
import { ContentOverlayRoot } from "./ContentOverlayRoot";
import { ControlOverlayRoot } from "./ControlOverlayRoot";
import { TransientOverlayRoot } from "./TransientOverlayRoot";
import type { OverlayRootProps } from "./OverlayRoot";

/** Selects a native surface without sharing an all-purpose OverlayRoot tree. */
export function OverlayWindowRoot(props: OverlayRootProps): JSX.Element {
  if (props.surface === "control") return <ControlOverlayRoot {...props} />;
  if (props.surface === "transient") return <TransientOverlayRoot {...props} />;
  return <ContentOverlayRoot {...props} panel={props.surface === "question" ? "question" : props.surface === "answer" ? "answer" : "all"} />;
}
