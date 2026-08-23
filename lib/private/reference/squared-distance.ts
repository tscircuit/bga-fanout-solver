export type PointLike = { x: number; y: number }

export const squaredDistance = (first: PointLike, second: PointLike) => {
  const deltaX = first.x - second.x
  const deltaY = first.y - second.y
  return deltaX * deltaX + deltaY * deltaY
}
