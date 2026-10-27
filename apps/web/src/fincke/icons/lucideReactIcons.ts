// apps/web/src/fincke/icons/lucideReactIcons.ts
// lucide-react's `icons` record w/ the hugeicons overrides swapped in
import { icons as lucideIcons } from "lucide-react/dist/esm/lucide-react.js";
import * as hugeiconComponents from "./hugeiconComponents";

// lucideIconByName only accepts components found here, so overrides must replace their entries.
// kept out of the shim module so the full lucide set stays in lucideIconByName's lazy chunk.
export const icons = /* @__PURE__ */ Object.assign({}, lucideIcons, hugeiconComponents);
