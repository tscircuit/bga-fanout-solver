import type { SimpleRouteJson } from "@tscircuit/core"

type Connection = SimpleRouteJson["connections"][number]

type FixedLayerDistributionOptions = {
  normalizeSourcePadGeometry?: boolean
  translateTargetX?: boolean
}

const sourcePoint = (connection: Connection) => connection.pointsToConnect[0]!
const targetPoint = (connection: Connection) => connection.pointsToConnect[1]!

const getSourceOrigin = (input: SimpleRouteJson) => ({
  x: Math.min(
    ...input.connections.map((connection) => sourcePoint(connection).x),
  ),
  y: Math.min(
    ...input.connections.map((connection) => sourcePoint(connection).y),
  ),
})

const sourceBallKey = (
  connection: Connection,
  origin: { x: number; y: number },
) => {
  const source = sourcePoint(connection)
  return `${(source.x - origin.x).toFixed(6)},${(source.y - origin.y).toFixed(6)}`
}

const getSourceComponentId = (input: SimpleRouteJson) => {
  const source = sourcePoint(input.connections[0]!)
  const sourceIds = [source.pointId, source.pcb_port_id].filter(Boolean)
  const obstacle = input.obstacles.find(
    (candidate) =>
      candidate.componentId &&
      candidate.layers.includes("top") &&
      sourceIds.some((id) => candidate.connectedTo.includes(id!)),
  )
  if (!obstacle?.componentId) {
    throw new Error(
      "No source component exists for the first captured BGA ball",
    )
  }
  return obstacle.componentId
}

const obstacleOrigin = (
  obstacles: SimpleRouteJson["obstacles"],
  componentId: string,
) => {
  const componentObstacles = obstacles.filter(
    (obstacle) =>
      obstacle.componentId === componentId && obstacle.layers.includes("top"),
  )
  return {
    x: Math.min(...componentObstacles.map((obstacle) => obstacle.center.x)),
    y: Math.min(...componentObstacles.map((obstacle) => obstacle.center.y)),
  }
}

const obstacleKey = (
  obstacle: SimpleRouteJson["obstacles"][number],
  origin: { x: number; y: number },
) =>
  `${(obstacle.center.x - origin.x).toFixed(6)},${(
    obstacle.center.y - origin.y
  ).toFixed(6)}`

const normalizeSourcePadGeometry = (
  input: SimpleRouteJson,
  reference: SimpleRouteJson,
) => {
  const sourceComponentId = getSourceComponentId(input)
  const referenceComponentId = getSourceComponentId(reference)
  const inputOrigin = obstacleOrigin(input.obstacles, sourceComponentId)
  const referenceOrigin = obstacleOrigin(
    reference.obstacles,
    referenceComponentId,
  )
  const referenceObstacleByPosition = new Map(
    reference.obstacles
      .filter(
        (obstacle) =>
          obstacle.componentId === referenceComponentId &&
          obstacle.layers.includes("top"),
      )
      .map((obstacle) => [obstacleKey(obstacle, referenceOrigin), obstacle]),
  )

  for (const obstacle of input.obstacles) {
    if (
      obstacle.componentId !== sourceComponentId ||
      !obstacle.layers.includes("top")
    ) {
      continue
    }
    const referenceObstacle = referenceObstacleByPosition.get(
      obstacleKey(obstacle, inputOrigin),
    )
    if (!referenceObstacle) {
      throw new Error(
        `No validated pad geometry exists at ${obstacleKey(obstacle, inputOrigin)}`,
      )
    }
    obstacle.width = referenceObstacle.width
    obstacle.height = referenceObstacle.height
  }
}

const applyLayerDistribution = (
  input: SimpleRouteJson,
  reference: SimpleRouteJson,
) => {
  const inputOrigin = getSourceOrigin(input)
  const referenceOrigin = getSourceOrigin(reference)
  const referenceConnectionBySourceBall = new Map(
    reference.connections.map((connection) => [
      sourceBallKey(connection, referenceOrigin),
      connection,
    ]),
  )
  const inputConnectionNameByReferenceName = new Map<string, string>()

  for (const connection of input.connections) {
    const referenceConnection = referenceConnectionBySourceBall.get(
      sourceBallKey(connection, inputOrigin),
    )
    if (!referenceConnection) {
      throw new Error(
        `No validated target layer exists for source ball ${sourceBallKey(connection, inputOrigin)}`,
      )
    }
    inputConnectionNameByReferenceName.set(
      referenceConnection.name,
      connection.name,
    )
    targetPoint(connection).layer = targetPoint(referenceConnection).layer
  }

  for (const [busIndex, bus] of (input.buses ?? []).entries()) {
    const referenceBus = reference.buses?.[busIndex]
    if (!referenceBus?.preferredLayers) {
      throw new Error(
        `No validated layer preferences exist for bus ${bus.busId}`,
      )
    }
    delete bus.allowedLayers
    delete bus.preferredLayer
    bus.preferredLayers = [...referenceBus.preferredLayers]
  }

  return {
    inputConnectionNameByReferenceName,
    inputOrigin,
    referenceConnectionBySourceBall,
    referenceOrigin,
  }
}

export const createFixedLayerDistributionFixture = (
  capturedInput: SimpleRouteJson,
  referenceInput: SimpleRouteJson,
  options: FixedLayerDistributionOptions = {},
) => {
  const input = structuredClone(capturedInput)
  const {
    inputConnectionNameByReferenceName,
    inputOrigin,
    referenceConnectionBySourceBall,
    referenceOrigin,
  } = applyLayerDistribution(input, referenceInput)
  const targetOffset = {
    x: inputOrigin.x - referenceOrigin.x,
    y: inputOrigin.y - referenceOrigin.y,
  }

  for (const connection of input.connections) {
    const referenceConnection = referenceConnectionBySourceBall.get(
      sourceBallKey(connection, inputOrigin),
    )!
    const target = targetPoint(connection)
    const referenceTarget = targetPoint(referenceConnection)
    target.y = referenceTarget.y + targetOffset.y
    if (options.translateTargetX) {
      target.x = referenceTarget.x + targetOffset.x
    }
  }

  for (const [busIndex, bus] of (input.buses ?? []).entries()) {
    const referenceBus = referenceInput.buses?.[busIndex]
    if (!referenceBus) {
      throw new Error(`No validated ordering exists for bus ${bus.busId}`)
    }
    bus.connectionNames = referenceBus.connectionNames.map(
      (connectionName) =>
        inputConnectionNameByReferenceName.get(connectionName)!,
    )

    for (const [referenceName, inputName] of referenceBus.connectionNames.map(
      (referenceName) =>
        [
          referenceName,
          inputConnectionNameByReferenceName.get(referenceName)!,
        ] as const,
    )) {
      const inputExitTarget = bus.connectionExitTargets?.[inputName]
      const referenceExitTarget =
        referenceBus.connectionExitTargets?.[referenceName]
      if (!inputExitTarget || !referenceExitTarget) continue
      inputExitTarget.y = referenceExitTarget.y + targetOffset.y
      if (options.translateTargetX) {
        inputExitTarget.x = referenceExitTarget.x + targetOffset.x
      }
    }
  }

  if (options.translateTargetX) {
    const referenceTargetsRight =
      referenceInput.connections.reduce(
        (sum, connection) => sum + targetPoint(connection).x,
        0,
      ) /
        referenceInput.connections.length >
      referenceInput.connections.reduce(
        (sum, connection) => sum + sourcePoint(connection).x,
        0,
      ) /
        referenceInput.connections.length
    if (referenceTargetsRight) {
      input.bounds.maxX = Math.max(
        input.bounds.maxX,
        referenceInput.bounds.maxX + targetOffset.x,
      )
    } else {
      input.bounds.minX = Math.min(
        input.bounds.minX,
        referenceInput.bounds.minX + targetOffset.x,
      )
    }
  }

  if (options.normalizeSourcePadGeometry) {
    normalizeSourcePadGeometry(input, referenceInput)
  }

  return input
}
