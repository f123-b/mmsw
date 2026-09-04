import type { JSX } from "react";
import { ControlOverlayRoot } from "./ControlOverlayRoot";
import { TransientOverlayRoot } from "./TransientOverlayRoot";
import { OverlayRoot, type OverlayRootProps } from "./OverlayRoot";
import { ScriptOverlayRoot } from "./ScriptOverlayRoot";
import { WrittenOverlayRoot } from "./WrittenOverlayRoot";

/** Selects a native surface without sharing an all-purpose OverlayRoot tree. */
export function OverlayWindowRoot(props: OverlayRootProps): JSX.Element {
  if (props.operationMode === "WRITTEN_TEST" && props.surface === "question") return <WrittenOverlayRoot {...props} />;
  if (props.surface === "control") return <ControlOverlayRoot {...props} />;
  if (props.surface === "script") return <ScriptOverlayRoot {...props} />;
  if (props.surface === "transient") return <TransientOverlayRoot {...props} />;
  return <OverlayRoot {...props} />;
}
