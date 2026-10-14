// Pixie mark: a pixel sprite drawn on the same square-pixel grid as the Pix logo.
const ROWS = ["..####..", ".######.", "########", "#..##..#", "########", "########", "########", "#.##.##."];

const RECTS = ROWS.flatMap((row, y) => [...row].flatMap((cell, x) => (cell === "#" ? [{ x, y }] : [])));

export function PixieIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" className={className}>
      {RECTS.map(({ x, y }) => <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} />)}
    </svg>
  );
}
