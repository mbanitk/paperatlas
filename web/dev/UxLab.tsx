/**
 * Dev-only UX lab (/__ux): every shared primitive and its known edge cases, so `npm run ux:check` and a human
 * can verify them at 390–1440px without touching live data. Loaded only by the dev server (see App.tsx).
 *
 * Probes used by dev/ux-check.mjs:
 * - [data-probe="edge-left"] / [data-probe="edge-right"]: fixed triggers at (8, header + 4) and (innerWidth − 8, header + 4)
 * - #clip-box: tooltip/popover triggers inside an overflow-hidden box
 * - ?toast=1: shows toasts while the sticky action bar is open (they must not intersect)
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { ApiError } from '../src/api/client'
import { StickyActionBar } from '../src/components/ActionBar'
import {
  BlockerBadge,
  CategoryChip,
  CodeToken,
  Delta,
  DocTypeChip,
  EffortChip,
  LevelTag,
  LiveDot,
  MetricName,
  ModeBadge,
  OutcomeBadge,
  StatusChip,
  Tag,
  VerdictBadge,
} from '../src/components/Badges'
import { ConfirmDialog, Modal } from '../src/components/Dialog'
import { DataTable, TableScroll, type Column } from '../src/components/Table'
import { useToast } from '../src/components/Toast'
import { InfoPopover, Term, Tooltip, Truncate } from '../src/components/Tooltip'
import {
  AnswerBlock,
  Banner,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ChipRow,
  Counter,
  DefinitionList,
  Disclosure,
  EmptyState,
  ErrorState,
  IconButton,
  MathText,
  PageHeader,
  Skeleton,
  StatTile,
  TabPanel,
  Tabs,
} from '../src/components/ui'
import { MoreIcon, RerunIcon } from '../src/components/Icons'
import { formatClaimed, formatRange, formatSigned, humanizeMetric, sanitizeText } from '../src/lib/format'
import { ADOPTION, CLAIM_CHECK, DIAGNOSIS, EXPERIMENT_STATUS, FIDELITY, LIKELIHOOD } from '../src/lib/semantics'

const DEFINITION = 'Verification budget D: how many draft tokens the target model checks per step before it accepts or rejects them.'

interface Row {
  id: number
  title: string
  status: string
  verdict: string | null
  adoption: string | null
  delta: number | null
  adoptionDelta: number | null
  chosen: boolean
  updated: string
}

const ROWS: Row[] = [
  { id: 6, title: 'Speculative verification with a dynamic draft tree (MLX)', status: 'awaiting_decision', verdict: 'partial', adoption: 'regression', delta: 2.8, adoptionDelta: -63.1, chosen: true, updated: '2026-11-24T10:10:00Z' },
  { id: 5, title: 'Bundle: KV-cache quantisation + paged attention', status: 'merged', verdict: 'reproduced', adoption: 'not_reproduced', delta: 5.4, adoptionDelta: 0.5, chosen: false, updated: '2026-11-23T08:00:00Z' },
  { id: 3, title: 'Selectable block sizes for the 4^{-b} penalty', status: 'dropped', verdict: 'not_reproduced', adoption: 'regression', delta: 0.3, adoptionDelta: -21.5, chosen: false, updated: '2026-11-22T08:00:00Z' },
  { id: 7, title: 'Persistent chunk buffer', status: 'failed', verdict: null, adoption: null, delta: null, adoptionDelta: null, chosen: false, updated: '2026-11-21T08:00:00Z' },
]

const COLUMNS: Column<Row>[] = [
  { key: 'title', header: 'Experiment', cell: (row) => <MathText>{`#${row.id} ${row.title}`}</MathText>, className: 'min-w-56' },
  { key: 'status', header: 'Status', cell: (row) => <StatusChip status={row.status} />, nowrap: true, cardSlot: 'badge' },
  {
    key: 'outcome',
    header: 'Outcome',
    nowrap: true,
    cell: (row) =>
      row.verdict ? (
        <div className="flex flex-col items-start gap-1">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs text-muted">Claim</span> <OutcomeBadge kind="verdict" value={row.verdict} short /> <Delta value={row.delta} />
          </span>
          {row.adoption && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-muted">Here</span> <OutcomeBadge kind="adoption" value={row.adoption} short /> <Delta value={row.adoptionDelta} />
            </span>
          )}
        </div>
      ) : (
        <span className="text-muted">Not measured yet</span>
      ),
  },
  { key: 'chosen', header: 'Chosen', srOnlyHeader: true, cell: (row) => (row.chosen ? <Tag>Chosen</Tag> : null), priority: 3, cardSlot: 'hidden' },
  { key: 'workload', header: 'Workload', cell: () => <CodeToken>concurrent_4</CodeToken>, priority: 3 },
  { key: 'metric', header: 'Metric', cell: () => <MetricName metric="throughput_tokens_per_s" showId />, priority: 2 },
  { key: 'updated', header: 'Updated', cell: (row) => <span className="tabular-nums">{row.updated.slice(0, 10)}</span>, numeric: true, priority: 2 },
]

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <Card title={title} id={id} className="scroll-mt-4">
      {children}
    </Card>
  )
}

export default function UxLab() {
  const [params] = useSearchParams()
  const toast = useToast()
  const [tab, setTab] = useState<'overview' | 'evidence' | 'raw'>('overview')
  const [confirm, setConfirm] = useState(false)
  const [form, setForm] = useState(false)
  const [selected, setSelected] = useState(true)
  const [checked, setChecked] = useState(true)
  const shownToast = useRef(false)

  useEffect(() => {
    if (params.get('toast') === '1' && !shownToast.current) {
      shownToast.current = true
      toast.success('Explanation ready for claim #168.')
      toast.error('The worker didn’t pick up the job. It stays queued; retry from System.')
    }
  }, [params, toast])

  return (
    <div className="space-y-6 pt-6">
      {/* Fixed probes at the exact positions from the WS0 acceptance criteria. */}
      <span data-probe="edge-left" className="fixed top-[calc(var(--header-h)+4px)] left-2 z-(--z-actionbar)">
        <Tooltip content="Edge probe (left): this tooltip must stay inside the viewport and below the header." asChild>
          <button type="button" aria-label="Left edge tooltip probe" className="size-6 rounded-full border border-line bg-canvas text-xs text-muted">
            L
          </button>
        </Tooltip>
      </span>
      <span data-probe="edge-right" className="fixed top-[calc(var(--header-h)+4px)] right-2 z-(--z-actionbar)">
        <InfoPopover label="Right edge popover probe" title="Edge probe (right)" content={DEFINITION} placement="top-end" />
      </span>

      <PageHeader
        breadcrumb={[{ label: 'Dev', to: '/' }, { label: 'UX lab' }]}
        eyebrow="Workstream 0 · shared primitives"
        title="UX lab: every primitive, every edge case"
        answer={
          <>
            Nothing here overlaps, clips or scrolls sideways at <strong>390 to 1440 px</strong>.
          </>
        }
        description="Dev-only page used by npm run ux:check. Client-side state only: nothing here calls the API."
        actions={
          <>
            <Button onClick={() => toast.success('Saved. This toast must not cover the action bar.')}>Show toast</Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>
              Open confirm
            </Button>
          </>
        }
      />

      <Section title="Tooltips, popovers and glossary terms" id="tooltips">
        <p className="max-w-prose text-sm">
          A glossary word in a sentence: speculative decoding checks a <Term definition={DEFINITION}>verification budget D</Term> of draft tokens per step,
          and the <Term definition="Number of function evaluations: how many times the model runs per generated token.">NFE</Term> drops. Hover, focus or
          tap them. A <Tooltip content="Tooltips carry one short sentence and open on hover, focus and tap.">plain tooltip</Tooltip> on text, and one on an
          icon button: <IconButton label="Re-run this experiment" icon={<RerunIcon />} />{' '}
          <InfoPopover title="Match score" content="Match = fit × (0.4 + expected gain) ÷ effort cost" learnMore={{ href: '/research/claims' }} label="How the match score is computed" />
        </p>
        <div className="-mx-2 mt-4 flex items-center justify-between gap-2">
          <Tooltip content="Left side of the content area: must shift right, never off-screen.">
            <span className="tag">Left trigger</span>
          </Tooltip>
          <Tooltip content="Right side of the content area: a long sentence that would run past the right edge on a phone if the tooltip didn't shift.">
            <span className="tag">Right trigger</span>
          </Tooltip>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div id="clip-box" className="relative h-16 overflow-hidden rounded-md border border-dashed border-line p-2 text-sm">
            <div className="text-xs text-muted">overflow-hidden box</div>
            <div className="absolute right-2 bottom-1 flex items-center gap-2">
              <Tooltip content="Rendered in a portal: the box doesn't clip it.">
                <span className="tag">Clipped?</span>
              </Tooltip>
              <Term definition={DEFINITION}>Term</Term>
            </div>
          </div>
          <div className="@container h-16 overflow-x-auto rounded-md border border-dashed border-line p-2 text-sm">
            <div className="text-xs text-muted">@container + overflow-x-auto</div>
            <div className="w-[480px]">
              <InfoPopover content="Container queries create a stacking context; the portal escapes it." label="Container popover">
                <span className="tag">Popover in a scroller</span>
              </InfoPopover>
            </div>
          </div>
          <div className="rounded-md border border-dashed border-line p-2 text-sm">
            <div className="text-xs text-muted">Truncated label</div>
            <div className="w-40">
              <Truncate>Operand-specific block quantisation with per-row scales</Truncate>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Status, outcomes and deltas" id="badges">
        <div className="space-y-3">
          <ChipRowList label="Experiment status" items={Object.keys(EXPERIMENT_STATUS).map((status) => <StatusChip key={status} status={status} />)} />
          <ChipRowList label="Claim check" items={Object.keys(CLAIM_CHECK).map((value) => <OutcomeBadge key={value} kind="verdict" value={value} explain />)} />
          <ChipRowList label="Adoption check" items={Object.keys(ADOPTION).map((value) => <OutcomeBadge key={value} kind="adoption" value={value} explain />)} />
          <ChipRowList label="Expected here (dashed)" items={Object.keys(LIKELIHOOD).map((value) => <OutcomeBadge key={value} kind="likelihood" value={value} />)} />
          <ChipRowList label="Diagnosis" items={Object.keys(DIAGNOSIS).map((value) => <OutcomeBadge key={value} kind="diagnosis" value={value} />)} />
          <ChipRowList label="Fidelity" items={Object.keys(FIDELITY).map((value) => <OutcomeBadge key={value} kind="fidelity" value={value} />)} />
          <ChipRowList
            label="Deltas"
            items={[
              <Delta key="a" value={2.8} significant ci={[0.9, 4.6]} />,
              <Delta key="b" value={-63.1} significant />,
              <Delta key="c" value={0.5} significant={false} ci={[-0.4, 1.2]} />,
              <Delta key="d" value={null} />,
            ]}
          />
          <ChipRowList
            label="Tags"
            items={[
              <CategoryChip key="a" category="kv_cache" />,
              <ModeBadge key="b" mode="bundle" bundleSize={2} />,
              <ModeBadge key="c" mode="chain" />,
              <DocTypeChip key="d" docType="patent" />,
              <EffortChip key="e" effort="high" />,
              <LevelTag key="f" kind="risk" level="medium" />,
              <BlockerBadge key="g" blocker="cost model: at most +1.5% on this engine (overhead-bound, 58% of bandwidth)" />,
              <Tag key="h" title="Requires a CUDA GPU">
                Requires CUDA
              </Tag>,
              <CodeToken key="i" label={humanizeMetric('throughput_tokens_per_s')}>
                throughput_tokens_per_s
              </CodeToken>,
              <Counter key="j" value={5} tone="attention" />,
              <LiveDot key="k" status="open" />,
              <VerdictBadge key="l" verdict="not_reproduced" />,
            ]}
          />
          <div>
            <div className="mb-1 text-xs text-muted">ChipRow: at most 3, then +N</div>
            <ChipRow items={['Decoding', 'KV cache', 'Quantisation', 'Apple Silicon', 'MLX', 'Speculative'].map((label) => <Tag key={label}>{label}</Tag>)} />
          </div>
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" attention>
          <CardHeader
            eyebrow={
              <>
                <span>Claim</span>
                <span>· #168</span>
                <span>· arXiv 2606.24033</span>
              </>
            }
            title={<MathText>{'Selectable block sizes remove the 4^{-b} penalty at 2.6\\times lower memory'}</MathText>}
            summary="Lets each layer choose 16- or 32-element blocks, so the quantisation error stops growing with the bit width and decoding reads fewer bytes per token."
            summaryLines={2}
            status={<StatusChip status="awaiting_decision" />}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <AnswerBlock register="predicted" value={formatRange(5, 30)} badge={<OutcomeBadge kind="likelihood" value="likely" short />} confidence="cost model · roofline 10 h ago" />
            <AnswerBlock register="claimed" value="2.63×" confidence="accelerator simulator" />
            <AnswerBlock register="measured" value={formatSigned(-63.1)} tone="negative" badge={<OutcomeBadge kind="adoption" value="regression" short />} confidence="95% CI −66 to −60% · 20 rounds" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Disclosure label="Explain">
              <p className="text-sm">Plain-language deep dive: the primer, the usual approach vs the paper’s idea, and the steps.</p>
            </Disclosure>
            <Disclosure label="Evidence" meta="(3 tables)">
              <p className="text-sm">{sanitizeText('Measured 84.9061 tokens/s vs 0…+10% expected; \\alpha \\le 0.5.')}</p>
            </Disclosure>
            <Disclosure label="Raw claim card">
              <pre className="overflow-x-auto rounded bg-canvas-inset p-2 text-xs">{'{"metric":"throughput_tokens_per_s","claimed":null}'}</pre>
            </Disclosure>
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button>Merge anyway</Button>
            <Button variant="primary">Drop</Button>
          </div>
        </Card>
        <Card title="Stat tiles">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Needs you" value={5} context="gates waiting for a decision" to="/__ux#badges" attention />
            <StatTile label="Result (wraps, never truncates)" value="32.2 to 79.1%" context="speed-up across 4 models" />
            <StatTile label="Hugging Face upvotes" value="1,204" delta={<Delta value={12.5} />} />
            <StatTile label="Claim" value={formatClaimed(null)} info="The paper describes the effect but reports no number." />
          </div>
        </Card>
      </div>

      <Section title="Tabs (← → Home End)">
        <Tabs
          id="lab-tabs"
          label="Lab tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'evidence', label: 'Evidence', count: 3 },
            { value: 'raw', label: 'Raw', count: 2, attention: true },
          ]}
        />
        <TabPanel tabsId="lab-tabs" value={tab} className="pt-3 text-sm">
          Panel: {tab}
        </TabPanel>
      </Section>

      <Section title="Tables: no page-level horizontal scroll">
        <p className="mb-2 text-sm text-muted">List table: cards below 768 px, priority-3 columns hidden below 1024 px.</p>
        <DataTable label="Experiments (lab)" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} rowHref={(row) => `/__ux#row-${row.id}`} />
        <p className="mt-4 mb-2 text-sm text-muted">Data table with a sticky first column and an sr-only header (the OV-21 regression).</p>
        <TableScroll label="Tuning rounds (lab)" stickyFirstColumn>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="bg-canvas-subtle px-3 py-2 font-medium">Round</th>
                {['draft_len', 'tree_width', 'accept_rate', 'ttft_ms', 'itl_ms', 'throughput'].map((header) => (
                  <th key={header} className="px-3 py-2 font-medium">
                    {humanizeMetric(header)}
                  </th>
                ))}
                <th className="px-3 py-2">
                  <span className="sr-only">Chosen</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3].map((round) => (
                <tr key={round} className="border-b border-line-muted">
                  <td className="px-3 py-2">Round {round}</td>
                  {[4, 8, 0.71, 158.2, 12.4, 84.9].map((value, index) => (
                    <td key={index} className="px-3 py-2 tabular-nums">
                      {value}
                    </td>
                  ))}
                  <td className="px-3 py-2">{round === 2 && <Tag>Chosen</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="States">
          <div className="space-y-3">
            <ErrorState error={new ApiError(503, 'GET /lab/experiments failed with HTTP 503', { service: 'lab-api' })} onRetry={() => toast.show('Retrying…')} />
            <Banner tone="caution">Gate 3: your decision is needed. See the recommendation below.</Banner>
            <EmptyState title="No gates are waiting for you" action={<Button size="sm">Pick claims to test</Button>}>
              New claims appear after the next research scan.
            </EmptyState>
            <div data-ux-static="">
              <Skeleton variant="row" count={2} />
            </div>
          </div>
        </Section>
        <Section title="Forms, checkboxes and dialogs">
          <div className="space-y-3">
            <Checkbox id="lab-check" checked={checked} onChange={setChecked} label="Select for testing" description="24 × 24 hit area around a 16 px box" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="checkbox" checked={selected} onChange={(event) => setSelected(event.target.checked)} /> Raw input with .checkbox
            </label>
            <DefinitionList items={[['Flag', <CodeToken key="f">--draft-tree</CodeToken>], ['Claimed', null], ['Metric', <MetricName key="m" metric="decode_tokens_per_s" showId />]]} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setForm(true)}>Open form dialog</Button>
              <Button variant="danger" onClick={() => setConfirm(true)}>
                Open danger confirm
              </Button>
              <IconButton label="More actions" icon={<MoreIcon />} />
            </div>
          </div>
        </Section>
      </div>

      <StickyActionBar
        label="Selection"
        summary={
          <>
            <strong>2 selected</strong> · Speculative verification, Selectable block sizes
          </>
        }
        actions={
          <>
            <Button size="sm" variant="invisible">
              Clear
            </Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>
              Review & start
            </Button>
          </>
        }
      />

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => setConfirm(false)}
        title="Merge experiment #6?"
        confirmLabel="Merge anyway"
        variant="danger"
        recap={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Claim <OutcomeBadge kind="verdict" value="partial" short /> <Delta value={2.8} /> · Here <OutcomeBadge kind="adoption" value="regression" short />{' '}
            <Delta value={-63.1} />
          </span>
        }
        warning={
          <>
            Merging puts code on <CodeToken>main</CodeToken> that makes the default workload slower when the flag is on. The flag stays off by default.
          </>
        }
        cost="Lab only: nothing is merged from this page."
      >
        <p>
          The recommendation is <strong>Drop</strong>. <Term definition={DEFINITION}>Verification budget</Term> explains why the gain didn’t carry over.
        </p>
      </ConfirmDialog>
      <Modal
        open={form}
        onClose={() => setForm(false)}
        title="Run research scan"
        footer={
          <>
            <Button onClick={() => setForm(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setForm(false)}>
              Start scan
            </Button>
          </>
        }
      >
        <label className="label" htmlFor="lab-limit">
          Max papers to summarise (1–500)
        </label>
        <input id="lab-limit" className="input" type="number" defaultValue={30} />
      </Modal>
    </div>
  )
}

function ChipRowList({ label, items }: { label: string; items: ReactNode[] }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted">{label}</div>
      <div className="flex flex-wrap items-center gap-2">{items}</div>
    </div>
  )
}
