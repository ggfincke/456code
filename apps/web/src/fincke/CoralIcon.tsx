// apps/web/src/fincke/CoralIcon.tsx
// renders coral's pixel mark in its kelp forest colors
import type { Icon } from "../components/Icons";

// coral/src/tui/shell/welcome.ts owns the full grid; src/tui/themes.ts owns the colors
export const CoralIcon: Icon = (props) => (
  <svg {...props} viewBox="2 0 18 11" fill="none" shapeRendering="crispEdges">
    <path fill="#2ea88a" d="M10 0h2v1H10z" />
    <path fill="#37a688" d="M7 1h2v1H7zM10 1h6v1H10z" />
    <path fill="#40a486" d="M7 2h9v1H7z" />
    <path fill="#4aa284" d="M5 3h2v1H5zM8 3h7v1H8zM16 3h2v1H16z" />
    <path fill="#53a082" d="M5 4h2v1H5zM8 4h7v1H8zM16 4h2v1H16z" />
    <path fill="#5c9e80" d="M3 5h2v1H3zM6 5h2v1H6zM9 5h5v1H9zM15 5h2v1H15zM18 5h2v1H18z" />
    <path fill="#659c7e" d="M3 6h2v1H3zM6 6h2v1H6zM9 6h5v1H9zM15 6h2v1H15zM18 6h2v1H18z" />
    <path fill="#6e9a7c" d="M4 7h2v1H4zM7 7h2v1H7zM10 7h6v1H10zM17 7h2v1H17z" />
    <path fill="#78987a" d="M4 8h2v1H4zM7 8h2v1H7zM10 8h6v1H10zM17 8h2v1H17z" />
    <path fill="#819678" d="M2 9h18v1H2z" />
    <path fill="#8a9476" d="M3 10h16v1H3z" />
  </svg>
);
