import React, { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { useGLTF, Line } from '@react-three/drei'
import * as THREE from 'three'
import './GameScene.css'
import ScoutModel from '../assets/models/Mech.glb?url'
import VerdantGuardianModel from '../assets/models/Beetle.glb?url'
import BuildingModelUrl from '../assets/models/Building.glb?url'

const GRID_SIZE = 8
const TILE_SIZE = 1
const TILE_GAP = 0.05
const TILE_HEIGHT = 0.02
const PLAYER_MOVE_RANGE = 3
const ENEMY_MOVE_RANGE = 2
const MAX_HEALTH = 3

export type GridCoord = [number, number]
export type PlayerPhase = 'move' | 'attack'
export type CursorMode = 'selecting' | 'moving' | 'canNotMove' | 'attack' | 'canNotAttack'
/** Facing as [deltaRow, deltaCol] e.g. [-1,0]=up, [1,0]=down, [0,1]=right, [0,-1]=left */
export type Facing = [number, number]
export type Turn = 'player' | 'enemy'
export type EnemyState = { position: GridCoord; facing: Facing; health: number; shakeUntil?: number }
export type BuildingState = { position: GridCoord; health: number }

/** Convert grid row/col to world XZ position (Y is 0 at tile surface). */
function gridToWorld(row: number, col: number): [number, number] {
  const half = (GRID_SIZE * TILE_SIZE) / 2
  const offset = -half + TILE_SIZE / 2
  const x = col * TILE_SIZE + offset
  const z = row * TILE_SIZE + offset
  return [x, z]
}

/** River tiles (water); stepping or being pushed here = drown. */
const RIVER_TILES: GridCoord[] = [
  [4, 3], [4, 4], [4, 5], [4, 6],
]
function isRiverTile(coord: GridCoord): boolean {
  return RIVER_TILES.some(([r, c]) => r === coord[0] && c === coord[1])
}

/** Four-direction neighbors (row, col). */
const CARDINAL_OFFSETS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]]

/** Tiles reachable from start in at most maxSteps steps without stepping on occupied or river. */
function getReachableTiles(start: GridCoord, occupied: Set<string>, maxSteps: number): Set<string> {
  const out = new Set<string>()
  const visited = new Set<string>()
  visited.add(coordKey(start))
  let frontier: GridCoord[] = [start]
  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const nextFrontier: GridCoord[] = []
    for (const [r, c] of frontier) {
      for (const [dr, dc] of CARDINAL_OFFSETS) {
        const r2 = r + dr
        const c2 = c + dc
        if (r2 < 0 || r2 >= GRID_SIZE || c2 < 0 || c2 >= GRID_SIZE) continue
        const key = `${r2},${c2}`
        if (visited.has(key) || occupied.has(key) || isRiverTile([r2, c2])) continue
        visited.add(key)
        out.add(key)
        nextFrontier.push([r2, c2])
      }
    }
    frontier = nextFrontier
  }
  return out
}

/** Tiles the player can move to (reachable in PLAYER_MOVE_RANGE steps without crossing occupied or river). */
function getValidMoveTiles(playerPos: GridCoord, occupied: Set<string>): Set<string> {
  return getReachableTiles(playerPos, occupied, PLAYER_MOVE_RANGE)
}

function coordKey(c: GridCoord): string {
  return `${c[0]},${c[1]}`
}

/** One step from pos toward target (for direction). */
function oneStepToward(pos: GridCoord, target: GridCoord): GridCoord | null {
  const [r, c] = pos
  const [tr, tc] = target
  const dr = tr - r
  const dc = tc - c
  if (dr === 0 && dc === 0) return null
  let r2 = r
  let c2 = c
  if (Math.abs(dr) >= Math.abs(dc) && dr !== 0) r2 = r + Math.sign(dr)
  else if (dc !== 0) c2 = c + Math.sign(dc)
  r2 = Math.max(0, Math.min(GRID_SIZE - 1, r2))
  c2 = Math.max(0, Math.min(GRID_SIZE - 1, c2))
  return [r2, c2]
}

/** Path from `from` to `to` avoiding occupied and river tiles (BFS). Returns [] if unreachable. */
function getPath(from: GridCoord, to: GridCoord, occupied: Set<string>): GridCoord[] {
  if (from[0] === to[0] && from[1] === to[1]) return [from]
  const visited = new Set<string>()
  visited.add(coordKey(from))
  const parent = new Map<string, GridCoord>()
  let frontier: GridCoord[] = [from]
  while (frontier.length > 0) {
    const nextFrontier: GridCoord[] = []
    for (const [r, c] of frontier) {
      for (const [dr, dc] of CARDINAL_OFFSETS) {
        const r2 = r + dr
        const c2 = c + dc
        if (r2 < 0 || r2 >= GRID_SIZE || c2 < 0 || c2 >= GRID_SIZE) continue
        const key = `${r2},${c2}`
        if (visited.has(key) || occupied.has(key) || isRiverTile([r2, c2])) continue
        visited.add(key)
        parent.set(key, [r, c])
        if (r2 === to[0] && c2 === to[1]) {
          const path: GridCoord[] = [[r2, c2]]
          let back: GridCoord = [r, c]
          while (back[0] !== from[0] || back[1] !== from[1]) {
            path.unshift(back)
            const k = coordKey(back)
            back = parent.get(k)!
          }
          path.unshift(from)
          return path
        }
        nextFrontier.push([r2, c2])
      }
    }
    frontier = nextFrontier
  }
  return []
}

/** Enemy move tile: up to ENEMY_MOVE_RANGE steps toward the player, never onto occupied or river. */
function getEnemyMoveTile(enemyPos: GridCoord, playerPos: GridCoord, occupied: Set<string>): GridCoord | null {
  let tile: GridCoord | null = enemyPos
  for (let i = 0; i < ENEMY_MOVE_RANGE; i++) {
    const next: GridCoord | null = tile ? oneStepToward(tile, playerPos) : null
    if (!next || (next[0] === tile![0] && next[1] === tile![1])) break
    const key = coordKey(next)
    if (occupied.has(key) || isRiverTile(next)) break
    tile = next
  }
  return tile && (tile[0] !== enemyPos[0] || tile[1] !== enemyPos[1]) ? tile : null
}

/** Attack tile with priority: building first, then player. Enemy can attack any of 4 adjacent tiles. */
function getEnemyAttackTileWithPriority(
  enemyPos: GridCoord,
  playerPos: GridCoord,
  buildings: BuildingState[]
): GridCoord | null {
  const [r, c] = enemyPos
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r2 = r + dr
    const c2 = c + dc
    if (r2 < 0 || r2 >= GRID_SIZE || c2 < 0 || c2 >= GRID_SIZE) continue
    const isBuilding = buildings.some(
      (b) => b.health > 0 && b.position[0] === r2 && b.position[1] === c2
    )
    if (isBuilding) return [r2, c2]
  }
  return oneStepToward(enemyPos, playerPos)
}

/** Tiles adjacent to pos (Manhattan 1) for attack range. */
function getAdjacentTiles(pos: GridCoord): Set<string> {
  const [r, c] = pos
  const out = new Set<string>()
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const r2 = r + dr
    const c2 = c + dc
    if (r2 >= 0 && r2 < GRID_SIZE && c2 >= 0 && c2 < GRID_SIZE) out.add(`${r2},${c2}`)
  }
  return out
}

/** Facing from move from (r0,c0) to (r1,c1). */
function facingFromMove(from: GridCoord, to: GridCoord): Facing {
  const dr = to[0] - from[0]
  const dc = to[1] - from[1]
  if (dr === 0 && dc === 0) return [0, 1]
  if (Math.abs(dr) >= Math.abs(dc)) return [Math.sign(dr), 0]
  return [0, Math.sign(dc)]
}

const DEFAULT_COLOR = '#1a2744'
const HOVER_COLOR = '#2d3f6b'
const SELECTED_COLOR = '#4a6bb5'
const VALID_MOVE_COLOR = '#253556'
const VALID_ATTACK_COLOR = '#5a3040'
const ATTACK_PREVIEW_COLOR = '#b03040'
const RIVER_COLOR = '#1e4d6b'
const RIVER_EMISSIVE = '#0d2d42'

type GridCoordNull = GridCoord | null

interface TileProps {
  x: number
  z: number
  row: number
  col: number
  isRiver: boolean
  isHovered: boolean
  isSelected: boolean
  isValidMove: boolean
  isValidAttack: boolean
  isAttackPreview: boolean
  onHover: (enter: boolean, row: number, col: number) => void
  onClick: () => void
}

function Tile({ x, z, row, col, isRiver, isHovered, isSelected, isValidMove, isValidAttack, isAttackPreview, onHover, onClick }: TileProps) {
  const color = isRiver
    ? RIVER_COLOR
    : isAttackPreview
      ? ATTACK_PREVIEW_COLOR
      : isSelected
        ? SELECTED_COLOR
        : isHovered
          ? HOVER_COLOR
          : isValidAttack
            ? VALID_ATTACK_COLOR
            : isValidMove
              ? VALID_MOVE_COLOR
              : DEFAULT_COLOR
  const y = TILE_HEIGHT / 2

  return (
    <group position={[x, 0, z]}>
      <mesh
        position={[0, y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        onPointerEnter={() => onHover(true, row, col)}
        onPointerLeave={() => onHover(false, row, col)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          onClick()
        }}
      >
        <planeGeometry args={[TILE_SIZE - TILE_GAP, TILE_SIZE - TILE_GAP]} />
        <meshStandardMaterial
          color={color}
          emissive={isRiver ? RIVER_EMISSIVE : (isAttackPreview || isHovered || isSelected || isValidMove || isValidAttack ? color : '#000000')}
          emissiveIntensity={isRiver ? 0.08 : (isAttackPreview ? 0.35 : isHovered || isSelected ? 0.2 : isValidMove || isValidAttack ? 0.1 : 0)}
        />
      </mesh>
    </group>
  )
}

interface TacticalGridProps {
  turn: Turn
  playerPhase: PlayerPhase
  playerPosition: GridCoord
  occupiedTiles: Set<string>
  attackPreviewTiles: GridCoord[]
  canMoveThisTurn: boolean
  validAttackTiles: Set<string>
  onMovePlayer: (row: number, col: number) => void
  onPlayerAttack: (row: number, col: number) => void
  onHoverTile: (row: number, col: number, ctx: { isValidMove: boolean; isValidAttack: boolean }) => void
}

function TacticalGrid({
  turn,
  playerPhase,
  playerPosition,
  occupiedTiles,
  attackPreviewTiles,
  canMoveThisTurn,
  validAttackTiles,
  onMovePlayer,
  onPlayerAttack,
  onHoverTile,
}: TacticalGridProps) {
  const [hoveredTile, setHoveredTile] = useState<GridCoordNull>(null)
  const attackPreviewSet = new Set(attackPreviewTiles.map((c) => coordKey(c)))

  const validMoves = getValidMoveTiles(playerPosition, occupiedTiles)
  const canMove = turn === 'player' && playerPhase === 'move' && canMoveThisTurn
  const inAttackPhase = turn === 'player' && playerPhase === 'attack'

  const half = (GRID_SIZE * TILE_SIZE) / 2
  const offset = -half + TILE_SIZE / 2

  const tiles: React.ReactNode[] = []
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const x = col * TILE_SIZE + offset
      const z = row * TILE_SIZE + offset
      const isHovered = hoveredTile?.[0] === row && hoveredTile?.[1] === col
      const isPlayerTile = playerPosition[0] === row && playerPosition[1] === col
      const isValidMove = canMove && validMoves.has(`${row},${col}`)
      const isValidAttack = inAttackPhase && validAttackTiles.has(`${row},${col}`)
      const isAttackPreview = attackPreviewSet.has(`${row},${col}`)
      const isRiver = RIVER_TILES.some(([r, c]) => r === row && c === col)
      tiles.push(
        <Tile
          key={`${row}-${col}`}
          x={x}
          z={z}
          row={row}
          col={col}
          isRiver={isRiver}
          isHovered={isHovered}
          isSelected={isPlayerTile}
          isValidMove={isValidMove}
          isValidAttack={isValidAttack}
          isAttackPreview={isAttackPreview}
          onHover={(enter) => {
            setHoveredTile(enter ? [row, col] : null)
            if (enter) onHoverTile(row, col, { isValidMove, isValidAttack })
            else onHoverTile(-1, -1, { isValidMove: false, isValidAttack: false })
          }}
          onClick={() => {
            if (turn !== 'player') return
            if (playerPhase === 'move' && validMoves.has(`${row},${col}`)) onMovePlayer(row, col)
            if (playerPhase === 'attack' && validAttackTiles.has(`${row},${col}`)) onPlayerAttack(row, col)
          }}
        />
      )
    }
  }

  const pathPreview =
    canMove && hoveredTile && validMoves.has(coordKey(hoveredTile))
      ? getPath(playerPosition, hoveredTile, occupiedTiles)
      : []

  return (
    <>
      {tiles}
      {pathPreview.length > 1 && <PathPreview path={pathPreview} />}
    </>
  )
}

const PATH_PREVIEW_Y = TILE_HEIGHT + 0.06
const PATH_LINE_COLOR = '#5a8fd4'
const PATH_NODE_COLOR = '#7ab0e8'
const ENEMY_PATH_LINE_COLOR = '#e58c8c'
const ENEMY_PATH_NODE_COLOR = '#f2b3b3'

function PathPreview({
  path,
  color = PATH_LINE_COLOR,
  nodeColor = PATH_NODE_COLOR,
}: {
  path: GridCoord[]
  color?: string
  nodeColor?: string
}) {
  const points = React.useMemo(() => {
    return path.map(([r, c]) => {
      const [x, z] = gridToWorld(r, c)
      return [x, PATH_PREVIEW_Y, z] as [number, number, number]
    })
  }, [path])

  if (points.length < 2) return null

  return (
    <group raycast={() => null}>
      <Line points={points} color={color} lineWidth={2} />
      {points.map((p, i) => (
        <mesh key={i} position={[p[0], p[1], p[2]]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, 0.2, 16]} />
          <meshBasicMaterial color={nodeColor} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}

interface GridModelProps {
  url: string
  row: number
  col: number
  facing: Facing
  scale?: number
}

const HEALTH_BAR_HEIGHT = 0.15
const HEALTH_BAR_Y_OFFSET = 1.25
const BUILDING_HEALTH_BAR_Y_OFFSET = 0.25
const SEGMENT_WIDTH = 0.2
const SEGMENT_GAP = 0.03
const CHARACTER_SCALE_PLAYER = 0.7
const CHARACTER_SCALE_ENEMY = 0.5

function HealthBar3D({
  row,
  col,
  current,
  max,
  fillColor,
  emptyColor,
  yOffset = HEALTH_BAR_Y_OFFSET,
}: {
  row: number
  col: number
  current: number
  max: number
  fillColor: string
  emptyColor: string
  yOffset?: number
}) {
  const [x, z] = gridToWorld(row, col)
  const y = TILE_HEIGHT + yOffset
  const totalWidth = max * SEGMENT_WIDTH + (max - 1) * SEGMENT_GAP
  const startX = -totalWidth / 2 + SEGMENT_WIDTH / 2 + SEGMENT_GAP / 2

  return (
    <group position={[x, y, z]} raycast={() => null}>
      {Array.from({ length: max }, (_, i) => (
        <mesh
          key={i}
          position={[startX + i * (SEGMENT_WIDTH + SEGMENT_GAP), 0, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[SEGMENT_WIDTH, HEALTH_BAR_HEIGHT]} />
          <meshBasicMaterial
            color={i < current ? fillColor : emptyColor}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}

const SHAKE_AMOUNT = 0.06
const SHAKE_DURATION_MS = 250

function ShakeGroup({
  shakeUntil,
  onShakeComplete,
  children,
}: {
  shakeUntil: number
  onShakeComplete?: () => void
  children: React.ReactNode
}) {
  const ref = useRef<THREE.Object3D>(null)
  const completedRef = useRef(false)
  useFrame(() => {
    if (!ref.current) return
    const now = performance.now()
    if (now < shakeUntil) {
      completedRef.current = false
      const t = 1 - (shakeUntil - now) / SHAKE_DURATION_MS
      const decay = 1 - t * t
      ref.current.position.x = (Math.random() - 0.5) * 2 * SHAKE_AMOUNT * decay
      ref.current.position.y = (Math.random() - 0.5) * 2 * SHAKE_AMOUNT * decay
      ref.current.position.z = (Math.random() - 0.5) * 2 * SHAKE_AMOUNT * decay
    } else {
      ref.current.position.x = 0
      ref.current.position.y = 0
      ref.current.position.z = 0
      if (onShakeComplete && !completedRef.current) {
        completedRef.current = true
        onShakeComplete()
      }
    }
  })
  return (
    <group ref={ref} raycast={() => null}>
      {children}
    </group>
  )
}

function GridModel({ url, row, col, facing, scale = 1 }: GridModelProps) {
  const { scene } = useGLTF(url)
  const [x, z] = gridToWorld(row, col)
  const y = TILE_HEIGHT
  const [dr, dc] = facing
  const rotationY = Math.atan2(dc, dr)

  const clone = scene.clone()
  clone.traverse((child) => {
    if ('castShadow' in child) (child as THREE.Object3D).castShadow = true
    if ('receiveShadow' in child) (child as THREE.Object3D).receiveShadow = true
  })

  const isPlayerMech = url === ScoutModel
  const mechOffsetY = isPlayerMech ? 1 : 0.5

  return (
    <group position={[x, y, z]} rotation={[0, rotationY, 0]} scale={scale} raycast={() => null}>
      <group position={[0, mechOffsetY, 0]}>
        <primitive object={clone} />
      </group>
    </group>
  )
}

function CameraLookAt() {
  const { camera } = useThree()
  useFrame(() => camera.lookAt(0, 0, 0))
  return null
}

function Ground() {
  const half = (GRID_SIZE * TILE_SIZE) / 2 + 1
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
      <planeGeometry args={[half * 2, half * 2]} />
      <meshStandardMaterial color="#0f1628" />
    </mesh>
  )
}

const BUILDING_HEIGHT = 0.8
const BUILDING_HEALTH_COLOR = '#f59e0b'
const BUILDING_HEALTH_EMPTY = '#3d2e1a'
const BUILDING_GLB_SCALE = 0.5
const MOUNTAIN_COLOR = '#6b7280'

function BuildingModel({ row, col }: { row: number; col: number }) {
  const { scene } = useGLTF(BuildingModelUrl)
  const [x, z] = gridToWorld(row, col)
  const y = TILE_HEIGHT + BUILDING_HEIGHT / 2
  const clone = scene.clone()
  clone.traverse((child) => {
    if ('castShadow' in child) (child as THREE.Object3D).castShadow = true
    if ('receiveShadow' in child) (child as THREE.Object3D).receiveShadow = true
  })
  return (
    <group position={[x, y, z]} scale={BUILDING_GLB_SCALE} raycast={() => null}>
      <primitive object={clone} />
    </group>
  )
}

function MountainModel({ row, col }: { row: number; col: number }) {
  const [x, z] = gridToWorld(row, col)
  const y = TILE_HEIGHT + 0.4
  return (
    <group position={[x, y, z]} raycast={() => null}>
      <mesh castShadow receiveShadow>
        <coneGeometry args={[0.45, 0.8, 4]} />
        <meshStandardMaterial color={MOUNTAIN_COLOR} />
      </mesh>
    </group>
  )
}

interface SceneProps {
  turn: Turn
  playerPhase: PlayerPhase
  playerPosition: GridCoord
  playerFacing: Facing
  playerHealth: number
  playerShakeUntil: number
  playerRemoved: boolean
  enemies: EnemyState[]
  buildings: BuildingState[]
  attackPreviewTiles: GridCoord[]
  enemyMoveTelegraphs: GridCoordNull[]
  occupiedTiles: Set<string>
  canMoveThisTurn: boolean
  validAttackTiles: Set<string>
  onMovePlayer: (row: number, col: number) => void
  onPlayerAttack: (row: number, col: number) => void
  onHoverTile: (row: number, col: number, ctx: { isValidMove: boolean; isValidAttack: boolean }) => void
  onPlayerShakeComplete: () => void
  onEnemyShakeComplete: (positionKey: string) => void
}

function Scene({
  turn,
  playerPhase,
  playerPosition,
  playerFacing,
  playerHealth,
  playerShakeUntil,
  playerRemoved,
  enemies,
  buildings,
  attackPreviewTiles,
  enemyMoveTelegraphs,
  occupiedTiles,
  canMoveThisTurn,
  validAttackTiles,
  onMovePlayer,
  onPlayerAttack,
  onHoverTile,
  onPlayerShakeComplete,
  onEnemyShakeComplete,
}: SceneProps) {
  const aliveBuildings = buildings.filter((b) => b.health > 0)
  const showPlayer = playerHealth > 0 || (playerHealth === 0 && !playerRemoved)
  const enemyPaths: (GridCoord[] | null)[] = enemies.map((e, i) => {
    if (e.health <= 0) return null
    const move = enemyMoveTelegraphs[i]
    if (!move) return null
    const occ = new Set(occupiedTiles)
    occ.delete(coordKey(e.position))
    const path = getPath(e.position, move, occ)
    return path.length > 1 ? path : null
  })
  return (
    <>
      <CameraLookAt />
      <ambientLight intensity={1} />
      <directionalLight
        position={[6, 14, 6]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-far={50}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={15}
        shadow-camera-bottom={-15}
      />
      <Ground />
      <TacticalGrid
        turn={turn}
        playerPhase={playerPhase}
        playerPosition={playerPosition}
        occupiedTiles={occupiedTiles}
        attackPreviewTiles={attackPreviewTiles}
        canMoveThisTurn={canMoveThisTurn}
        validAttackTiles={validAttackTiles}
        onMovePlayer={onMovePlayer}
        onPlayerAttack={onPlayerAttack}
        onHoverTile={onHoverTile}
      />
      {enemyPaths.map(
        (path, i) =>
          path && (
            <PathPreview
              key={`enemy-path-${i}`}
              path={path}
              color={ENEMY_PATH_LINE_COLOR}
              nodeColor={ENEMY_PATH_NODE_COLOR}
            />
          )
      )}
      {MOUNTAINS.map(([row, col], i) => (
        <MountainModel key={`m-${i}`} row={row} col={col} />
      ))}
      <Suspense fallback={null}>
        {aliveBuildings.map((b, i) => (
          <group key={`b-${i}`}>
            <BuildingModel row={b.position[0]} col={b.position[1]} />
            <HealthBar3D
              row={b.position[0]}
              col={b.position[1]}
              current={b.health}
              max={MAX_HEALTH}
              fillColor={BUILDING_HEALTH_COLOR}
              emptyColor={BUILDING_HEALTH_EMPTY}
              yOffset={BUILDING_HEIGHT + BUILDING_HEALTH_BAR_Y_OFFSET}
            />
        </group>
        ))}
      </Suspense>
      <Suspense fallback={null}>
        {showPlayer && (
          <ShakeGroup
            shakeUntil={playerShakeUntil}
            onShakeComplete={playerHealth === 0 ? onPlayerShakeComplete : undefined}
          >
            <GridModel
              url={ScoutModel}
              row={playerPosition[0]}
              col={playerPosition[1]}
              facing={playerFacing}
              scale={CHARACTER_SCALE_PLAYER}
            />
            <HealthBar3D
              row={playerPosition[0]}
              col={playerPosition[1]}
              current={playerHealth}
              max={MAX_HEALTH}
              fillColor={PLAYER_HEALTH_COLOR}
              emptyColor={PLAYER_HEALTH_EMPTY}
            />
          </ShakeGroup>
        )}
        {enemies.map((enemy) =>
          (enemy.health > 0 || (enemy.health === 0 && enemy.shakeUntil != null)) ? (
            <ShakeGroup
              key={coordKey(enemy.position)}
              shakeUntil={enemy.shakeUntil ?? 0}
              onShakeComplete={enemy.health === 0 ? () => onEnemyShakeComplete(coordKey(enemy.position)) : undefined}
            >
              <GridModel
                url={VerdantGuardianModel}
                row={enemy.position[0]}
                col={enemy.position[1]}
                facing={enemy.facing}
                scale={CHARACTER_SCALE_ENEMY}
              />
              <HealthBar3D
                row={enemy.position[0]}
                col={enemy.position[1]}
                current={enemy.health}
                max={MAX_HEALTH}
                fillColor={ENEMY_HEALTH_COLOR}
                emptyColor={ENEMY_HEALTH_EMPTY}
              />
            </ShakeGroup>
          ) : null
        )}
      </Suspense>
    </>
  )
}

const INITIAL_PLAYER: GridCoord = [2, 1]
const INITIAL_PLAYER_FACING: Facing = [0, 1]
const INITIAL_ENEMIES: EnemyState[] = [
  { position: [7, 7], facing: [-1, 0], health: MAX_HEALTH },
  { position: [6, 6], facing: [-1, 0], health: MAX_HEALTH },
]
const INITIAL_BUILDINGS: BuildingState[] = [
  { position: [2, 3], health: MAX_HEALTH },
  { position: [5, 4], health: MAX_HEALTH },
]
/** Total building HP shown on HUD; game over when this reaches 0 */
const MAX_BUILDING_HEALTH_TOTAL = INITIAL_BUILDINGS.length * MAX_HEALTH
const MOUNTAINS: GridCoord[] = [
  [1, 5],
  [3, 6],
  [4, 1],
  [6, 2],
]

const ENEMY_TURN_DURATION_MS = 800

const PLAYER_HEALTH_COLOR = '#34c759'
const PLAYER_HEALTH_EMPTY = '#1a3d24'
const ENEMY_HEALTH_COLOR = '#e74c3c'
const ENEMY_HEALTH_EMPTY = '#4a2020'

const CURSOR_STYLES: Record<CursorMode, string> = {
  selecting: 'default',
  moving: 'pointer',
  canNotMove: 'not-allowed',
  attack: 'crosshair',
  canNotAttack: 'not-allowed',
}

function getEnemyTelegraphs(
  enemyPos: GridCoord,
  playerPos: GridCoord,
  occupied: Set<string>,
  buildings: BuildingState[]
): { move: GridCoordNull; attack: GridCoordNull } {
  // Always move toward the player; attack priority is handled by getEnemyAttackTileWithPriority.
  const move = getEnemyMoveTile(enemyPos, playerPos, occupied)
  const attack = move ? getEnemyAttackTileWithPriority(move, playerPos, buildings) : null
  return { move, attack }
}

/** One step from attacked tile in attack direction (player -> target). Used for knockback. */
function pushTarget(attackerPos: GridCoord, attackedTile: GridCoord): GridCoord {
  const dr = Math.sign(attackedTile[0] - attackerPos[0])
  const dc = Math.sign(attackedTile[1] - attackerPos[1])
  const r = Math.max(0, Math.min(GRID_SIZE - 1, attackedTile[0] + dr))
  const c = Math.max(0, Math.min(GRID_SIZE - 1, attackedTile[1] + dc))
  return [r, c]
}

function getOccupiedTiles(
  playerPos: GridCoord,
  enemies: EnemyState[],
  buildings: BuildingState[],
  mountains: GridCoord[]
): Set<string> {
  const s = new Set<string>()
  s.add(coordKey(playerPos))
  enemies.filter((e) => e.health > 0).forEach((e) => s.add(coordKey(e.position)))
  buildings.filter((b) => b.health > 0).forEach((b) => s.add(coordKey(b.position)))
  mountains.forEach((m) => s.add(coordKey(m)))
  RIVER_TILES.forEach((r) => s.add(coordKey(r)))
  return s
}

export function GameScene() {
  const [turn, setTurn] = useState<Turn>('player')
  const [playerPhase, setPlayerPhase] = useState<PlayerPhase>('move')
  const [playerPosition, setPlayerPosition] = useState<GridCoord>(INITIAL_PLAYER)
  const [playerFacing, setPlayerFacing] = useState<Facing>(INITIAL_PLAYER_FACING)
  const [playerHealth, setPlayerHealth] = useState(MAX_HEALTH)
  const [enemies, setEnemies] = useState<EnemyState[]>(() =>
    INITIAL_ENEMIES.map((e) => ({ ...e }))
  )
  const [enemyMoveTelegraphs, setEnemyMoveTelegraphs] = useState<GridCoordNull[]>(() =>
    INITIAL_ENEMIES.map((e, i) => {
      const others = INITIAL_ENEMIES.filter((_, j) => j !== i)
      const occ = getOccupiedTiles(INITIAL_PLAYER, others, INITIAL_BUILDINGS, MOUNTAINS)
      occ.delete(coordKey(e.position))
      const { move } = getEnemyTelegraphs(e.position, INITIAL_PLAYER, occ, INITIAL_BUILDINGS)
      return move
    })
  )
  const [playerShakeUntil, setPlayerShakeUntil] = useState(0)
  const [playerRemoved, setPlayerRemoved] = useState(false)
  const [buildings, setBuildings] = useState<BuildingState[]>(() =>
    INITIAL_BUILDINGS.map((b) => ({ ...b }))
  )
  const [gameOver, setGameOver] = useState(false)
  const enemiesRef = useRef(enemies)
  enemiesRef.current = enemies

  const totalBuildingHealth = buildings.reduce((sum, b) => sum + b.health, 0)
  const [playerHasMovedThisTurn, setPlayerHasMovedThisTurn] = useState(false)
  const [cursorMode, setCursorMode] = useState<CursorMode>('selecting')

  const occupiedTiles = getOccupiedTiles(playerPosition, enemies, buildings, MOUNTAINS)
  const canMoveThisTurn = !playerHasMovedThisTurn
  const buildingTileSet = new Set(buildings.filter((b) => b.health > 0).map((b) => coordKey(b.position)))
  const validAttackTiles = new Set(
    [...getAdjacentTiles(playerPosition)].filter((key) => !buildingTileSet.has(key))
  )
  const attackPreviewTiles = enemies.flatMap((e, i) => {
    if (e.health <= 0) return []
    const move = enemyMoveTelegraphs[i] ?? e.position
    const t = getEnemyAttackTileWithPriority(move, playerPosition, buildings)
    return t ? [t] : []
  })

  useEffect(() => {
    if (totalBuildingHealth <= 0 || playerHealth <= 0) setGameOver(true)
  }, [totalBuildingHealth, playerHealth])

  useEffect(() => {
    if (turn !== 'enemy' || gameOver) return
    const t = setTimeout(() => {
      const nextOccupied = new Set<string>([coordKey(playerPosition)])
      buildings.filter((b) => b.health > 0).forEach((b) => nextOccupied.add(coordKey(b.position)))
      MOUNTAINS.forEach((m) => nextOccupied.add(coordKey(m)))
      const newEnemies = enemies.map((e, i) => {
        if (e.health <= 0) return e
        const move = enemyMoveTelegraphs[i]
        if (!move) return e
        const occ = new Set(nextOccupied)
        enemies.forEach((e2, j) => {
          if (j !== i && e2.health > 0) occ.add(coordKey(e2.position))
        })
        if (occ.has(coordKey(move))) return e
        nextOccupied.add(coordKey(move))
        return {
          ...e,
          position: move,
          facing: facingFromMove(e.position, move),
        }
      })
      newEnemies.forEach((e) => {
        if (e.health <= 0) return
        const attackTile = getEnemyAttackTileWithPriority(e.position, playerPosition, buildings)
        if (!attackTile) return
        if (playerPosition[0] === attackTile[0] && playerPosition[1] === attackTile[1]) {
          setPlayerHealth((h) => Math.max(0, h - 1))
          setPlayerShakeUntil(performance.now() + 250)
        }
        setBuildings((prev) =>
          prev.map((b) =>
            b.position[0] === attackTile[0] && b.position[1] === attackTile[1]
              ? { ...b, health: Math.max(0, b.health - 1) }
              : b
          )
        )
      })
      setEnemies(newEnemies)
      setEnemyMoveTelegraphs(
        newEnemies.map((e) => {
          if (e.health <= 0) return null
          const occ = getOccupiedTiles(playerPosition, newEnemies, buildings, MOUNTAINS)
          occ.delete(coordKey(e.position))
          const { move } = getEnemyTelegraphs(e.position, playerPosition, occ, buildings)
          return move
        })
      )
      setPlayerHasMovedThisTurn(false)
      setPlayerPhase('move')
      setTurn('player')
    }, ENEMY_TURN_DURATION_MS)
    return () => clearTimeout(t)
  }, [turn, gameOver])

  const handleMovePlayer = (row: number, col: number) => {
    if (gameOver || turn !== 'player' || playerPhase !== 'move' || !canMoveThisTurn) return
    const valid = getValidMoveTiles(playerPosition, occupiedTiles)
    if (valid.has(`${row},${col}`)) {
      setPlayerFacing(facingFromMove(playerPosition, [row, col]))
      setPlayerPosition([row, col])
      setPlayerHasMovedThisTurn(true)
      setPlayerPhase('attack')
    }
  }

  const handlePlayerAttack = (row: number, col: number) => {
    if (gameOver || turn !== 'player' || playerPhase !== 'attack') return
    if (!validAttackTiles.has(`${row},${col}`)) return
    const hitIndex = enemies.findIndex((e) => e.position[0] === row && e.position[1] === col)
    if (hitIndex < 0) {
      setPlayerPhase('move')
      setTurn('enemy')
      return
    }
    const pushDest = pushTarget(playerPosition, [row, col])
    const pushOccupied = new Set(occupiedTiles)
    pushOccupied.delete(coordKey([row, col]))
    RIVER_TILES.forEach((r) => pushOccupied.delete(coordKey(r)))
    const pushIsMountain = MOUNTAINS.some((m) => m[0] === pushDest[0] && m[1] === pushDest[1])
    const pushIntoRiver = isRiverTile(pushDest)
    const pushIsBuilding = buildings.some((b) => b.health > 0 && b.position[0] === pushDest[0] && b.position[1] === pushDest[1])
    const canPush = !pushOccupied.has(coordKey(pushDest)) && !pushIsMountain

    if (pushIsBuilding) {
      setBuildings((prev) =>
        prev.map((b) =>
          b.position[0] === pushDest[0] && b.position[1] === pushDest[1]
            ? { ...b, health: Math.max(0, b.health - 1) }
            : b
        )
      )
    }

    setEnemies((prev) =>
      prev.map((e, i) => {
        if (i !== hitIndex) return e
        const newPos = canPush ? pushDest : e.position
        const drown = canPush && pushIntoRiver
        const damage = drown ? MAX_HEALTH : (1 + (pushIsMountain ? 1 : 0))
        return {
          ...e,
          health: Math.max(0, e.health - damage),
          position: canPush ? newPos : e.position,
          facing: canPush ? facingFromMove(e.position, newPos) : e.facing,
          shakeUntil: performance.now() + 250,
        }
      })
    )
    setPlayerPhase('move')
    setTurn('enemy')
  }

  const handleCancelAttackPhase = () => {
    if (gameOver || turn !== 'player') return
    if (playerPhase === 'move') {
      // Skip remaining movement and go straight to attack phase
      setPlayerPhase('attack')
      return
    }
    if (playerPhase === 'attack') {
      // Cancel attack phase and end the turn
      setPlayerPhase('move')
      setTurn('enemy')
    }
  }

  const handleGoToAttackPhase = () => {
    if (gameOver || turn !== 'player' || playerPhase !== 'move') return
    setPlayerPhase('attack')
  }

  const handleEndTurn = () => {
    if (gameOver || turn !== 'player' || playerPhase !== 'attack') return
    setPlayerPhase('move')
    setTurn('enemy')
  }

  const handleRestart = () => {
    setGameOver(false)
    setTurn('player')
    setPlayerPhase('move')
    setPlayerPosition(INITIAL_PLAYER)
    setPlayerFacing(INITIAL_PLAYER_FACING)
    setPlayerHealth(MAX_HEALTH)
    setEnemies(INITIAL_ENEMIES.map((e) => ({ ...e })))
    setEnemyMoveTelegraphs(
      INITIAL_ENEMIES.map((e, i) => {
        const others = INITIAL_ENEMIES.filter((_, j) => j !== i)
        const occ = getOccupiedTiles(INITIAL_PLAYER, others, INITIAL_BUILDINGS, MOUNTAINS)
        occ.delete(coordKey(e.position))
        const { move } = getEnemyTelegraphs(e.position, INITIAL_PLAYER, occ, INITIAL_BUILDINGS)
        return move
      })
    )
    setPlayerShakeUntil(0)
    setPlayerRemoved(false)
    setBuildings(INITIAL_BUILDINGS.map((b) => ({ ...b })))
    setPlayerHasMovedThisTurn(false)
    setCursorMode('selecting')
  }

  const handleHoverTile = (row: number, col: number, ctx: { isValidMove: boolean; isValidAttack: boolean }) => {
    if (gameOver || row < 0 || col < 0) {
      setCursorMode('selecting')
      return
    }
    if (turn !== 'player') {
      setCursorMode('selecting')
      return
    }
    if (playerPhase === 'move') {
      setCursorMode(ctx.isValidMove ? 'moving' : 'canNotMove')
      return
    }
    setCursorMode(ctx.isValidAttack ? 'attack' : 'canNotAttack')
  }

  return (
    <div
      className="gameSceneRoot"
      style={{ width: '100vw', height: '100vh', position: 'relative', cursor: CURSOR_STYLES[cursorMode] }}
      onContextMenu={(e) => {
        e.preventDefault()
        handleCancelAttackPhase()
      }}
    >
      <Canvas
        shadows
        camera={{ position: [4, 14, 10], fov: 45 }}
        gl={{ antialias: true }}
      >
        <Scene
          turn={turn}
          playerPhase={playerPhase}
          playerPosition={playerPosition}
          playerFacing={playerFacing}
          playerHealth={playerHealth}
          playerShakeUntil={playerShakeUntil}
          playerRemoved={playerRemoved}
          enemies={enemies}
          buildings={buildings}
          attackPreviewTiles={attackPreviewTiles}
          enemyMoveTelegraphs={enemyMoveTelegraphs}
          occupiedTiles={occupiedTiles}
          canMoveThisTurn={canMoveThisTurn}
          validAttackTiles={validAttackTiles}
          onMovePlayer={handleMovePlayer}
          onPlayerAttack={handlePlayerAttack}
          onHoverTile={handleHoverTile}
          onPlayerShakeComplete={() => setPlayerRemoved(true)}
          onEnemyShakeComplete={(positionKey) => {
            const idx = enemiesRef.current.findIndex((e) => coordKey(e.position) === positionKey)
            setEnemies((prev) => prev.filter((e) => coordKey(e.position) !== positionKey))
            setEnemyMoveTelegraphs((prev) => (idx >= 0 ? prev.filter((_, i) => i !== idx) : prev))
          }}
        />
      </Canvas>
      <header className="hudBar">
        <div className="hudLeft">
          <span className={`turnBadge ${turn}`}>
            {turn === 'player' ? 'Your turn' : "Enemy's turn"}
          </span>
          {turn === 'player' && (
            <span className="phaseChip">
              {playerPhase === 'move' ? 'Move' : 'Attack'}
            </span>
          )}
          <div className="healthStrip">
            <span className="healthStripLabel">Bases</span>
            {Array.from({ length: MAX_BUILDING_HEALTH_TOTAL }, (_, i) => (
              <div
                key={i}
                className={`healthSegment ${i < totalBuildingHealth ? 'filled' : 'empty'}`}
                aria-hidden
              />
            ))}
          </div>
        </div>
        <div className="hudRight">
          {turn === 'player' && playerPhase === 'move' && (
            <button type="button" className="attackBtn" onClick={handleGoToAttackPhase}>
              Attack
            </button>
          )}
          {turn === 'player' && playerPhase === 'attack' && (
            <button type="button" className="endTurnBtn" onClick={handleEndTurn}>
              End turn
            </button>
          )}
          <p className="hintText">
            {turn === 'player'
              ? playerPhase === 'move'
                ? 'Click a highlighted tile to move.'
                : 'Click an adjacent enemy to attack.'
              : 'Enemy is moving…'}
          </p>
        </div>
      </header>
      {gameOver && (
        <div className="gameOverOverlay" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
          <div className="gameOverWindow">
            <h2 id="game-over-title" className="gameOverTitle">Game Over</h2>
            <p className="gameOverMessage">
              {playerHealth <= 0 ? 'Your mech has been destroyed.' : 'All bases have been destroyed.'}
            </p>
            <button type="button" className="restartBtn" onClick={handleRestart}>
              Restart
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
