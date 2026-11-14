// apps/mobile/src/components/ui/SliderRow.types.ts
// defines native slider preview and commit callbacks

import type { ComponentProps, ReactNode } from "react";
import type { SymbolView } from "./AppSymbol";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export interface SliderRowProps {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  // drawn in place of the symbol
  readonly iconSlot?: ReactNode;
  // colors the slider & the value; defaults to the theme's primary
  readonly tintColor?: string | undefined;
  // sits right under the slider, inside the row's padding
  readonly footer?: ReactNode;
  readonly minimumIcon?: SymbolName;
  readonly maximumIcon?: SymbolName;
  readonly label: string;
  readonly valueLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly onPreview?: (value: number) => void;
}
