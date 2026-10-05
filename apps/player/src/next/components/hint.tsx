import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement } from "react";

type HintProps = {
  label: string;
  /** The trigger (a button or link); it keeps its own `aria-label`, the hint is visual. */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
};

/**
 * A hover / focus tooltip on Base UI `Tooltip` (positioned with element.style, no injected
 * `<style>`), replacing native `title` on icon buttons. Needs `<Tooltip.Provider>` (App).
 */
export function Hint({ label, children, side = "bottom" }: HintProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tip-layer" side={side} sideOffset={6}>
          <Tooltip.Popup className="tip" data-testid="tooltip">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Shared delay so moving along a toolbar shows the next hint at once. */
export const HintProvider = Tooltip.Provider;
