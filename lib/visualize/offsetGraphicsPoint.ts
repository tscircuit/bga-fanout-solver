export const offsetGraphicsPoint = (
  point: { x: number; y: number },
  offset: number,
): void => {
  point.x += offset
  point.y += offset
}
