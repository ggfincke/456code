import type { Icon } from "../components/Icons";
import { cn } from "../lib/utils";

export const CoralIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="0 0 24 24" fill="none" className={cn("stroke-[#ff6f61]", className)}>
    <path
      d="M12 21V8m0 5-4-4m4 1 4-4m-4 10-5 3m5-2 5 3M8 9V5m8 1V3M7 19l-2-3m12 4 2-4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
