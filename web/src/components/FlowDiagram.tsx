import { useId, useMemo } from 'react'
import type { FlowDiagramData } from '../api/types'
import { FULL_METRICS, layoutFlow, MINI_METRICS, wrapLabel, type LaidOutNode } from '../lib/flow'
import { cx } from './ui'

/** Subtle per-kind colours (fill, stroke) — GitHub Primer-like tints. */
export const KIND_COLORS: Record<string, { fill: string; stroke: string; label: string }> = {
  input: { fill: '#f6f8fa', stroke: '#8c959f', label: 'input' },
  model: { fill: '#fbefff', stroke: '#a475f9', label: 'model' },
  step: { fill: '#ddf4ff', stroke: '#54aeff', label: 'step' },
  decision: { fill: '#fff8c5', stroke: '#d4a72c', label: 'decision' },
  memory: { fill: '#d8f6f0', stroke: '#33b3ae', label: 'memory / cache' },
  output: { fill: '#dafbe1', stroke: '#4ac26b', label: 'output' },
  hardware: { fill: '#eaeef2', stroke: '#6e7781', label: 'hardware' },
  data: { fill: '#fff1e5', stroke: '#fb8f44', label: 'data' },
}
const kindColor = (kind: string) => KIND_COLORS[kind] ?? KIND_COLORS.step
const ACCENT = '#0969da'
const EDGE = '#8c959f'
const LOOP = '#bf8700'

function Shape({ node, mini }: { node: LaidOutNode; mini: boolean }) {
  const color = kindColor(node.kind)
  const stroke = node.highlight ? ACCENT : color.stroke
  const strokeWidth = node.highlight ? (mini ? 1.6 : 2) : 1
  if (node.kind === 'decision') {
    const cx0 = node.x + node.width / 2
    const cy0 = node.y + node.height / 2
    const points = `${cx0},${node.y} ${node.x + node.width},${cy0} ${cx0},${node.y + node.height} ${node.x},${cy0}`
    return <polygon points={points} fill={color.fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
  }
  const radius = mini ? 4 : 9
  return (
    <g>
      <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={radius} fill={color.fill} stroke={stroke} strokeWidth={strokeWidth} />
      {!mini && <rect x={node.x + 1} y={node.y + 7} width={3} height={node.height - 14} rx={1.5} fill={color.stroke} opacity={0.85} />}
    </g>
  )
}

export interface FlowDiagramProps {
  diagram: FlowDiagramData | null | undefined
  variant?: 'full' | 'mini'
  className?: string
  /** Show the title and the "new" legend under a full diagram. */
  showCaption?: boolean
}

/**
 * Small left-to-right flow diagram (≤ 8 nodes): layered layout, per-kind tint, decisions as diamonds,
 * highlighted nodes (added/changed by the technique) with an accent border and a "new" tag,
 * dashed skip edges and a curved return arrow for loops.
 */
export function FlowDiagram({ diagram, variant = 'full', className, showCaption = true }: FlowDiagramProps) {
  const mini = variant === 'mini'
  const layout = useMemo(() => layoutFlow(diagram, mini ? MINI_METRICS : FULL_METRICS), [diagram, mini])
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!layout.nodes.length) return null

  const title = diagram?.title?.trim() || 'How it works'
  const order = [...layout.nodes].sort((a, b) => a.layer - b.layer || a.row - b.row)
  const description = order.map((node) => `${node.label}${node.highlight ? ' (new)' : ''}`).join(' → ')
  const highlighted = layout.nodes.filter((node) => node.highlight)
  const scale = mini ? 1.5 : 1

  return (
    <figure className={cx('m-0 min-w-0', className)}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width="100%"
        style={{ maxWidth: layout.width * scale, display: 'block' }}
        role="img"
        aria-labelledby={`${uid}-t ${uid}-d`}
        className="h-auto overflow-visible"
      >
        <title id={`${uid}-t`}>{title}</title>
        <desc id={`${uid}-d`}>{description}</desc>
        {!mini && (
          <defs>
            <marker id={`${uid}-a`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M0,0.5 L8,4 L0,7.5 z" fill={EDGE} />
            </marker>
            <marker id={`${uid}-l`} viewBox="0 0 8 8" refX="7.5" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M0,0.5 L8,4 L0,7.5 z" fill={LOOP} />
            </marker>
          </defs>
        )}
        <g fill="none">
          {layout.edges.map((edge, index) => {
            const loop = edge.route === 'loop'
            return (
              <path
                key={index}
                d={edge.path}
                stroke={loop ? LOOP : EDGE}
                strokeWidth={mini ? 0.9 : 1.3}
                strokeDasharray={edge.style === 'skip' ? (mini ? '2 2' : '4 3') : undefined}
                markerEnd={mini ? undefined : `url(#${uid}-${loop ? 'l' : 'a'})`}
                opacity={mini ? 0.8 : 1}
              />
            )
          })}
        </g>
        {layout.nodes.map((node) => (
          <g key={node.id}>
            <title>{`${node.label} · ${kindColor(node.kind).label}${node.highlight ? ' · new' : ''}`}</title>
            <Shape node={node} mini={mini} />
            {!mini &&
              (() => {
                const lines = wrapLabel(node.label, node.kind === 'decision' ? 11 : 15, 2)
                const lineHeight = 12
                const startY = node.y + node.height / 2 - ((lines.length - 1) * lineHeight) / 2 + 4
                return (
                  <text x={node.x + node.width / 2 + (node.kind === 'decision' ? 0 : 1.5)} textAnchor="middle" fontSize={node.kind === 'decision' ? 10 : 11} fill="#1f2328" fontWeight={node.highlight ? 600 : 500}>
                    {lines.map((line, i) => (
                      <tspan key={i} x={node.x + node.width / 2 + (node.kind === 'decision' ? 0 : 1.5)} y={startY + i * lineHeight}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )
              })()}
            {node.highlight &&
              (mini ? (
                <circle cx={node.x + node.width - 1} cy={node.y + 1} r={2.6} fill={ACCENT} stroke="#fff" strokeWidth={0.8} />
              ) : (
                <g>
                  <rect x={node.x + node.width - 26} y={node.y - 7} width={24} height={13} rx={6.5} fill={ACCENT} />
                  <text x={node.x + node.width - 14} y={node.y + 2.6} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#fff">
                    new
                  </text>
                </g>
              ))}
          </g>
        ))}
        {!mini &&
          layout.edges
            .filter((edge) => edge.label)
            .map((edge, index) => (
              <text
                key={`label-${index}`}
                x={edge.labelX}
                y={edge.route === 'forward' ? edge.labelY - 3 : edge.labelY}
                textAnchor="middle"
                fontSize={8.5}
                fill={edge.route === 'loop' ? '#9a6700' : '#59636e'}
                stroke="#fff"
                strokeWidth={3}
                paintOrder="stroke"
              >
                {edge.label}
              </text>
            ))}
      </svg>
      {!mini && showCaption && (diagram?.title || highlighted.length > 0) && (
        <figcaption className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          {diagram?.title && <span className="font-medium text-fg">{diagram.title}</span>}
          {highlighted.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-4 rounded-sm border-2 border-accent bg-canvas" aria-hidden="true" /> added or changed by the technique
            </span>
          )}
          {layout.edges.some((edge) => edge.route === 'loop') && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-4 rounded bg-attention-emphasis" aria-hidden="true" /> feedback loop
            </span>
          )}
        </figcaption>
      )}
    </figure>
  )
}

/** Labels of the nodes a technique adds or changes ("Adds: Draft block · Confidence gate"). */
export function changedNodes(diagram: FlowDiagramData | null | undefined): string[] {
  return (diagram?.nodes ?? []).filter((node) => node?.highlight && node.label).map((node) => node.label)
}
