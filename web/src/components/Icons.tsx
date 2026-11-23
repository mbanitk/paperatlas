import type { SVGProps } from 'react'

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
