export type GestureDirection = "pending" | "horizontal" | "vertical";

export function classifyGestureDirection(deltaX: number, deltaY: number, threshold = 10): GestureDirection {
  const horizontalDistance = Math.abs(deltaX);
  const verticalDistance = Math.abs(deltaY);
  if (Math.max(horizontalDistance, verticalDistance) < threshold) return "pending";

  return horizontalDistance > verticalDistance * 1.1 ? "horizontal" : "vertical";
}

export function nearestPixelIndex(pixelPositions: number[], pointerPosition: number): number {
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  pixelPositions.forEach((position, index) => {
    if (!Number.isFinite(position)) return;
    const distance = Math.abs(position - pointerPosition);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });

  return nearestIndex;
}
