import type { ReactNode, SVGProps } from 'react'
import type { SemanticIconName } from '../lib/semantics'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Svg>
)
export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Svg>
)
export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2l6.2 11H1.8z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Svg>
)
export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5v3.5M8 5v.01" />
  </Svg>
)
export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3h4v4M13 3L7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" />
  </Svg>
)
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Svg>
)
export const ChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l4 4 4-4" />
  </Svg>
)
export const ChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
)
export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 3.5v3h-3M3 12.5v-3h3" />
    <path d="M12.6 6.5A5 5 0 0 0 3.8 5M3.4 9.5a5 5 0 0 0 8.8 1.5" />
  </Svg>
)
export const FlaskIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2h4M6.5 2v4L3 13a1 1 0 0 0 .9 1.4h8.2A1 1 0 0 0 13 13L9.5 6V2" />
    <path d="M4.5 10h7" />
  </Svg>
)
export const BranchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
  </Svg>
)
export const MergeIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="10" r="1.5" />
    <path d="M4.5 5v6M4.5 5c0 3 3 5 5.5 5" />
  </Svg>
)
export const FileIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.8h5l3 3v9.4H4z" />
    <path d="M9 1.8v3h3" />
  </Svg>
)
export const BookIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.5 1.5 0 0 1 1.5-1.5h4z" />
  </Svg>
)
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6z" />
  </Svg>
)
export const ServerIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" />
  </Svg>
)
export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 3.5v9l7-4.5z" />
  </Svg>
)
export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </Svg>
)
export const GateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 14V5l5-3 5 3v9" />
    <path d="M6 14V9h4v5" />
  </Svg>
)
export const ListIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </Svg>
)
export const PulseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />
  </Svg>
)
export const CircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
  </Svg>
)
export const DotFillIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
  </Svg>
)
export const MinusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h8" />
  </Svg>
)
export const LogIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M4.5 6l2 2-2 2M8 10.5h3.5" />
  </Svg>
)

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
export const GraphIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="1.8" />
    <circle cx="12.5" cy="3.8" r="1.8" />
    <circle cx="12.5" cy="12.2" r="1.8" />
    <path d="M5.2 7.2l5.6-2.6M5.2 8.8l5.6 2.6" />
  </Svg>
)

// ---- explainer icons: themes, comparison aspects and diagram node kinds ------------------------
// Path sets are exported separately so the SVG flow diagrams can draw the same glyphs inside nodes.

const glyph = (paths: ReactNode) => (p: IconProps) => <Svg {...p}>{paths}</Svg>

export const GLYPHS = {
  speed: (
    <>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
      <path d="M8 11.5l3-3.5" />
      <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
    </>
  ),
  latency: (
    <>
      <circle cx="8" cy="9" r="5" />
      <path d="M8 6.5V9l1.8 1.2M6.5 1.8h3M8 1.8V4" />
    </>
  ),
  throughput: (
    <>
      <path d="M2 4.5h9M2 8h12M2 11.5h9" />
      <path d="M9.5 2.5l2 2-2 2M12 6l2 2-2 2M9.5 9.5l2 2-2 2" />
    </>
  ),
  memory: (
    <>
      <rect x="2" y="4.5" width="12" height="7" rx="1" />
      <path d="M4.5 4.5v-2M7 4.5v-2M9.5 4.5v-2M12 4.5v-2M4.5 11.5v2M7 11.5v2M9.5 11.5v2M12 11.5v2M5 7.2h6v1.6H5z" />
    </>
  ),
  quality: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <circle cx="8" cy="8" r="3.2" />
      <circle cx="8" cy="8" r="0.7" fill="currentColor" />
    </>
  ),
  cost: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M10 5.8C9.6 5.3 8.9 5 8 5c-1.2 0-2 .6-2 1.5S6.8 7.8 8 8s2 .7 2 1.5S9.2 11 8 11c-.9 0-1.6-.3-2-.8M8 3.8V5M8 11v1.2" />
    </>
  ),
  reliability: (
    <>
      <path d="M8 1.8l5 2v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z" />
      <path d="M5.8 8l1.6 1.6 2.9-3" />
    </>
  ),
  lightbulb: (
    <>
      <path d="M5.8 11.2C4.6 10.3 3.8 9 3.8 7.4a4.2 4.2 0 1 1 8.4 0c0 1.6-.8 2.9-2 3.8v1.3H5.8z" />
      <path d="M6.2 14.3h3.6" />
    </>
  ),
  chip: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <rect x="6.3" y="6.3" width="3.4" height="3.4" rx="0.4" />
      <path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />
    </>
  ),
  cube: (
    <>
      <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
      <path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" />
    </>
  ),
  runtime: (
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5" />
      <path d="M4.5 6.5l2 1.7-2 1.7M8.2 10h3" />
    </>
  ),
  workload: (
    <>
      <path d="M2.5 13.5h11" />
      <path d="M4 13.5V9M7 13.5V5M10 13.5V7.5M13 13.5V3" />
    </>
  ),
  baseline: (
    <>
      <path d="M8 2.5v11M4.5 13.5h7M3 5h10" />
      <path d="M3 5l-1.5 4a1.6 1.6 0 0 0 3 0zM13 5l-1.5 4a1.6 1.6 0 0 0 3 0z" />
    </>
  ),
  draft: (
    <>
      <path d="M10.5 2.5l3 3-7.5 7.5H3v-3z" />
      <path d="M9 4l3 3" />
    </>
  ),
  batch: (
    <>
      <path d="M8 2l6 3-6 3-6-3z" />
      <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  context: (
    <>
      <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
      <path d="M9.5 1.8V5h3M6 8h4.5M6 10.5h4.5" />
    </>
  ),
  input: (
    <>
      <path d="M9 3.5h3.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9" />
      <path d="M2 8h8M7 5l3 3-3 3" />
    </>
  ),
  step: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" />
    </>
  ),
  decision: (
    <>
      <path d="M8 1.8L14.2 8 8 14.2 1.8 8z" />
      <path d="M6.6 6.5a1.5 1.5 0 1 1 1.9 1.4c-.4.2-.5.5-.5.9M8 10.8v.01" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="3.8" rx="5" ry="1.8" />
      <path d="M3 3.8v8.4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.8M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
    </>
  ),
  output: (
    <>
      <path d="M7 3.5H3.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H7" />
      <path d="M6 8h8M11 5l3 3-3 3" />
    </>
  ),
  table: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.2" />
      <path d="M2 6h12M2 9.5h12M6.5 6v7.5" />
    </>
  ),
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  checklist: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8.2l2 2 4-4.2" />
    </>
  ),
  compare: (
    <>
      <rect x="1.8" y="3" width="5.4" height="10" rx="1" />
      <rect x="8.8" y="3" width="5.4" height="10" rx="1" />
      <path d="M3.5 6h2M3.5 8.5h2M10.5 6h2M10.5 8.5h2" />
    </>
  ),
  flow: (
    <>
      <rect x="1.5" y="5.5" width="4" height="5" rx="1" />
      <rect x="10.5" y="5.5" width="4" height="5" rx="1" />
      <path d="M5.5 8h5M8.5 6l2 2-2 2" />
    </>
  ),
  hash: <path d="M6 2.5l-1.5 11M11.5 2.5L10 13.5M2.8 5.8h11M2.2 10.2h11" />,
  // Replacements for Unicode pictographs (★ ↻ ‹/› ≈ ◐ =) — docs/ux-review.md §3.7.
  star: <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />,
  rerun: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
      <path d="M13.2 2.5v3h-3" />
    </>
  ),
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />,
  approx: <path d="M2.5 6.2c1.6-1.6 3.4-1.6 5.5 0s3.9 1.6 5.5 0M2.5 10.2c1.6-1.6 3.4-1.6 5.5 0s3.9 1.6 5.5 0" />,
  half: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" />
    </>
  ),
  equals: <path d="M3.5 6h9M3.5 10h9" />,
  question: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.4a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3M8 11.4v.01" />
    </>
  ),
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" />
    </>
  ),
  paper: (
    <>
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3M6 8h4M6 10.5h4" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type GlyphName = keyof typeof GLYPHS

export const SpeedIcon = glyph(GLYPHS.speed)
export const LatencyIcon = glyph(GLYPHS.latency)
export const ThroughputIcon = glyph(GLYPHS.throughput)
export const MemoryIcon = glyph(GLYPHS.memory)
export const QualityIcon = glyph(GLYPHS.quality)
export const CostIcon = glyph(GLYPHS.cost)
export const ReliabilityIcon = glyph(GLYPHS.reliability)
export const LightbulbIcon = glyph(GLYPHS.lightbulb)
export const ChipIcon = glyph(GLYPHS.chip)
export const CubeIcon = glyph(GLYPHS.cube)
export const ArrowUpIcon = glyph(GLYPHS.arrowUp)
export const ArrowDownIcon = glyph(GLYPHS.arrowDown)
export const ArrowRightIcon = glyph(GLYPHS.arrowRight)
export const ChecklistIcon = glyph(GLYPHS.checklist)
export const CompareIcon = glyph(GLYPHS.compare)
export const FlowIcon = glyph(GLYPHS.flow)
export const HashIcon = glyph(GLYPHS.hash)
export const StarIcon = glyph(GLYPHS.star)
export const RerunIcon = glyph(GLYPHS.rerun)
export const CodeIcon = glyph(GLYPHS.code)
export const ApproxIcon = glyph(GLYPHS.approx)
export const HalfIcon = glyph(GLYPHS.half)
export const EqualsIcon = glyph(GLYPHS.equals)
export const QuestionIcon = glyph(GLYPHS.question)
export const MenuIcon = glyph(GLYPHS.menu)
export const MoreIcon = glyph(GLYPHS.more)
export const PaperIcon = glyph(GLYPHS.paper)

/** Any glyph by name (themes, aspects, node kinds). */
export function Glyph({ name, ...props }: IconProps & { name: GlyphName }) {
  return <Svg {...props}>{GLYPHS[name]}</Svg>
}

/**
 * The icon that goes with a semantic value (lib/semantics.ts `icon`). Decorative: always put the word next to it.
 * `pulse` is the animated "working" dot.
 */
export function SemanticIcon({ name, size = 12, className }: { name: SemanticIconName; size?: number; className?: string }) {
  switch (name) {
    case 'pulse':
      return (
        <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center ${className ?? ''}`} style={{ width: size, height: size }}>
          <span className="animate-pulse-dot inline-block size-1.5 rounded-full bg-current" />
        </span>
      )
    case 'check':
      return <CheckIcon size={size} className={className} />
    case 'x':
      return <XIcon size={size} className={className} />
    case 'gate':
      return <GateIcon size={size} className={className} />
    case 'clock':
      return <ClockIcon size={size} className={className} />
    case 'merge':
      return <MergeIcon size={size} className={className} />
    case 'minus':
      return <MinusIcon size={size} className={className} />
    case 'half':
      return <HalfIcon size={size} className={className} />
    case 'equals':
      return <EqualsIcon size={size} className={className} />
    case 'arrow-up':
      return <ArrowUpIcon size={size} className={className} />
    case 'arrow-down':
      return <ArrowDownIcon size={size} className={className} />
    case 'paper':
      return <PaperIcon size={size} className={className} />
    case 'alert':
      return <AlertIcon size={size} className={className} />
    case 'question':
    default:
      return <QuestionIcon size={size} className={className} />
  }
}
