import type { JSX } from "react";
import { OverlayRoot, type OverlayRootProps } from "./OverlayRoot";

/** ContentWindow owns question/answer panels and the single end dialog. */
export function ContentOverlayRoot(props: OverlayRootProps): JSX.Element {
  return <OverlayRoot {...props} surface="content" />;
}
