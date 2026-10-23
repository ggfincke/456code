// apps/web/src/fincke/StopRing.tsx
// the turning ring around the composer stop button while a turn runs
import "./stopButton.css";

// hidden outside fincke ocean, where the upstream red button stays as is
export function FinckeStopRing() {
  return (
    <svg data-fincke-stop-ring="" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" strokeWidth="2" data-fincke-stop-ring-track="" />
      <path
        d="M16 2a14 14 0 0 1 14 14"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        data-fincke-stop-ring-arc=""
      />
    </svg>
  );
}
