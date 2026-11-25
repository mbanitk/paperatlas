# Shared UI primitives (WS0 foundation)

The building blocks every page uses. The spec behind them is
[`docs/ux-review.md`](../../../docs/ux-review.md) §2–3, on branch `mbanitk-ux-audit-of-the-console`. All
existing exports and props still work. The APIs below were added alongside them.

## Rules for page code

- **Words, tones and icons come from `lib/semantics.ts`.** Don't hard-code "Partial", "Regression" or a
  green/red class for an outcome. Use `OutcomeBadge`, `StatusChip` or `Delta`, or read
  `claimCheckSemantics()` and its siblings.
- **One meaning per colour.**

  | Tone | Means |
  | --- | --- |
  | `positive` (green) | A good outcome measured or expected **here** |
  | `negative` (red) | Harm or failure |
  | `caution` (amber) | Mixed, partial, or needs you |
  | `info` (blue) | In progress, links, selected, predicted |
  | `neutral` (grey) | None or no effect |
  | `merged` (purple) | Merged, and nothing else |
  | `reference` | The paper's number. Neutral ink with a paper icon, never green. |

  Legacy tone names (`success`, `attention`, `danger`, `accent`, `done`, `muted`) still work and map onto
  these. Use `semanticTone(tone)` before comparing tones.
- **Type scale.** Nothing readable goes below 12 px. Use `text-caption` (12/16), `text-body` (14/20),
  `text-body-lg` (16/24), `text-title` (20/28), `text-page` (24/32), `text-metric` (28/34, hero number) or
  `text-metric-sm` (20/28), or `text-xs`/`text-sm`. `npm run ux:check` lists every `text-[<12px]` it finds.
- **Contrast.** For chip text, use `text-<tone>-fg` on `bg-<tone>-subtle`; it's at least 6.5:1. Never put
  white text on amber. `text-subtle` is now AA, but use `text-muted` for anything people need to read.
- **No native `title` for information people need.** Use `Tooltip`, `InfoPopover` or `Term`. `Chip title=…`
  already renders an accessible Tooltip.
- **Numbers never truncate.** Wrap them, or let the grid drop a column. Use `Truncate` for names only.
- **Sticky UI reserves its own space.** `--header-h` comes from `Layout` and `--action-bar-h` from
  `StickyActionBar`. Anchors (`#gate`) and `scrollIntoView` already land below the header, because `html`
  has `scroll-padding-top`.
- **Tables.** Wrap every `<table>` in `TableScroll` (`relative overflow-x-auto`), which fixes the
  `sr-only` header that made pages scroll sideways (OV-21). List tables should use `DataTable`, which turns
  into cards below 768 px.
- **Hidden text inside scrolled content: use `sr-text`, not `sr-only`.** `sr-only` is
  `position: absolute`, so inside an unpositioned `overflow-x-auto` wrapper it escapes and widens the page.
  `sr-text` stays in flow. `<body>` also clips `overflow-x` as a safety net, but `ux:check` measures without
  that clip and still reports the culprit element.
- **Checkboxes.** Add `className="checkbox"` to raw `<input type="checkbox">`. It gives a 24×24 hit area
  around a 16 px box.

## `components/Tooltip.tsx`

Floating UI renders in a portal using `@floating-ui/react`, with flip, shift and size limited by the
header and action bar, and hides when its trigger scrolls under the header. Inside a `<dialog>`, it
portals into the dialog.

```tsx
<Tooltip content="Re-run on the current code">…</Tooltip>      // hover 300 ms, focus, tap; Esc closes
<Tooltip content="…" asChild><button>…</button></Tooltip>      // attach to the element itself
<InfoPopover title="Match score" content="Match = fit × (0.4 + expected gain) ÷ effort cost" />  // ⓘ button
<InfoPopover content={reasons} label="Why this estimate?">Why this estimate?</InfoPopover>
<Term definition="How many draft tokens the target model checks per step.">verification budget D</Term>
<Truncate lines={2}>{longTitle}</Truncate>                       // Tooltip only when it's actually cut
```

- `Tooltip` holds one short sentence and is not interactive. When the trigger is a text wrapper, it becomes
  focusable. When the trigger is a button, the button gets `aria-describedby`.
- `InfoPopover` uses `role="dialog"`. Click, tap, Enter or Space pins it open. Mouse hover previews it. Esc
  or an outside click closes it, and focus returns to the trigger. Use `learnMore={{ href }}` to add a link.
- `Term` replaces `<abbr title>` and the absolutely positioned `TermChip` tooltip.
- `floatingMiddleware()` and `edgePadding()` are exported for any custom floating UI.

## `components/Badges.tsx`

| Export | Use |
| --- | --- |
| `StatusChip status short? explain?` | Experiment status. Tint, icon or pulsing dot, and a sentence-case word. Never wraps. |
| `OutcomeBadge kind value detail? short? explain? size?` | `kind`: `verdict`, `adoption`, `likelihood` (dashed = predicted), `diagnosis` or `fidelity`. |
| `VerdictBadge` | Compatibility wrapper for `OutcomeBadge kind="verdict"`. No longer ALL CAPS. |
| `Delta value significant? ci? showLabel?` | Signed %, with ↑ or ↓. `significant={false}` shows "no clear change". `ci` puts the 95% CI in a Tooltip. |
| `Tag icon? to? title? maxCh?` | Neutral outline tag. Long text truncates at `maxCh`, with a Tooltip. |
| `CodeToken label?` | Flag, metric id or branch, in monospace. Never breaks mid-token. |
| `MetricName metric showId?` | Shows "Throughput (tokens/s)", plus the id as a `CodeToken` for experts. |
| `LevelTag kind level` | Shows "Effort: high ●●●" in neutral. `EffortChip` uses it. |
| `outcomeInfo(kind, value)` | The label, tone, icon and description behind a badge. |

`CategoryChip`, `ModeBadge` and `DocTypeChip` are neutral `Tag`s now. `BlockerBadge` is `caution`, with the
full blocker in a Tooltip.

## `components/ui.tsx` (new additions)

| Export | Use |
| --- | --- |
| `PageHeader answer? breadcrumb? level?` | `answer` is the one-line bottom line under the title. `level="object"` sets the detail-page h1 to 20/28. `breadcrumb` takes `[{label, to}]`. |
| `CardHeader eyebrow title summary status actions summaryLines?` | Card and row anatomy (§3.4). |
| `AnswerBlock register value unit? label? tone? confidence? badge? size?` | `register` is `claimed` (paper icon, neutral), `predicted` (dashed) or `measured` (tinted by `tone`). |
| `StatTile label value context? delta? to? attention? info?` | Stat tiles. The value wraps and never truncates. |
| `Disclosure label meta? defaultOpen? open? onToggle?` | The Explain, Evidence and Raw disclosures. Native `<details>`, rendered lazily. |
| `ChipRow items max=3` | Shows the first 3 items, then a "+N" popover. |
| `Tabs id?` + `TabPanel tabsId value` | Roving focus with ←/→/Home/End. `aria-controls` is set when you pass `id`. |
| `Skeleton variant="text"\|"card"\|"row"\|"chart" count?` | Placeholders shaped like the content. |
| `ErrorState` | A plain sentence first, then Retry, then a "Technical details" disclosure. Also exports `plainError(error)`. |
| `MathText` | Renders `"4^{-b} penalty"` as 4<sup>−b</sup> penalty. |
| `IconButton label icon` | Icon button with a hit area of at least 28 px and a Tooltip label. |
| `Breadcrumb items` | Standalone breadcrumb. |
| `Button size="lg"` | 40 px. Solid md and lg buttons are 44 px below 640 px. |
| `Card attention? selected?` | Caution ring when a gate needs you; info ring when selected. |
| `TONE_TEXT` | Text colour per tone. |

## `components/ActionBar.tsx`

```tsx
<StickyActionBar
  open={selected.length > 0}
  summary={<><strong>{n} selected</strong> · {titles}</>}
  actions={<><Button variant="invisible" size="sm">Clear</Button><Button variant="primary">Review & start</Button></>}
/>
```

The bar is one line, at most 64 px tall, and portalled to `<body>`. It publishes `--action-bar-h`, so the
page pads itself, toasts sit above the bar, and popovers avoid it. Show the list of titles in the dialog,
not in the bar.

## `components/Table.tsx`

```tsx
<TableScroll label="Tuning rounds" stickyFirstColumn><table>…</table></TableScroll>

<DataTable
  label="Experiments" rows={rows} rowKey={(r) => r.id} rowHref={(r) => `/experiments/${r.id}`}
  columns={[
    { key: 'title', header: 'Experiment', cell: (r) => r.title },                  // card title
    { key: 'status', header: 'Status', cell: (r) => <StatusChip status={r.status} />, cardSlot: 'badge', nowrap: true },
    { key: 'outcome', header: 'Outcome', cell: (r) => …, nowrap: true },
    { key: 'updated', header: 'Updated', cell: (r) => <RelativeTime iso={r.updated_at} />, priority: 2, numeric: true },
    { key: 'cta', header: 'Action', srOnlyHeader: true, cell: (r) => <Link …>Decide →</Link>, cardSlot: 'footer' },
  ]}
/>
```

- Priority 1 columns always show. Priority 2 columns hide below 768 px in `mobile="scroll"` mode. Priority 3
  columns hide below 1024 px and in cards.
- Cards use the `title`, `badge`, `body` (label and value), `footer` (CTA) and `hidden` slots. Put the
  decision columns (status, outcome) in `badge` or early in `body`, never last.
- `rowHref` makes the whole row a link through a stretched link on the title cell. Interactive content in a
  row should sit in the `badge` or `footer` slot, which stack above the link.

## `components/Dialog.tsx`

- `Modal initialFocus?` accepts a ref, `'first-field'` or `'none'`. By default, focus goes to the first form
  field.
- `ConfirmDialog recap? warning? cost? initialFocus? cancelLabel?` restates the decision. `recap` gives the
  evidence, `warning` shows a caution banner (for example when acting against the recommendation), and
  `cost` says what running it costs. Without a form field, focus starts on **Cancel**, never on the costly
  button.

## `components/Toast.tsx` and `components/Layout.tsx`

- Toasts sit top-centre below 640 px and bottom-right above `--action-bar-h` from 640 px up. Error toasts
  stay until they're dismissed.
- Below 768 px the header shows the current section, a **Needs you N** pill (linking to
  `/experiments?tab=needs_you`) and a **Menu** button that lists all 6 sections. Hash links (`/experiments/6#gate`)
  scroll below the header.

## `lib/semantics.ts`

`EXPERIMENT_STATUS`, `CLAIM_CHECK`, `ADOPTION`, `LIKELIHOOD`, `DIAGNOSIS`, `FIDELITY`, `BOTTLENECK` and their
`*Semantics(value)` lookups each return `{ label, short?, tone, icon, description }`. The module also exports:

- `gainSemantics(delta, { significant })`, which returns better, worse or no clear change;
- `levelSemantics('effort' | 'risk' | 'fit', level)`;
- `REGISTER`, `GATE`, `MODE` and `VOCAB`, which hold the approved words (Appendix B);
- `semanticTone` and `legacyTone`.

`lib/stages.ts` (`statusInfo`, `verdictInfo`) and `lib/roofline.ts` (`likelihoodInfo`, `bottleneckInfo`)
re-export from it. `lib/protocol.ts` (WS3) should re-export `ADOPTION`, `DIAGNOSIS` and `FIDELITY` the same way.

## `lib/format.ts` (new helpers)

| Helper | Example |
| --- | --- |
| `formatRange(low, high, { unit, signed, digits, fallback })` | `0 to +10%`, `+5 to +30%`, `12 to 30 ms`, or "Not estimated" when missing |
| `formatSigned(value, { unit, digits })` | `+2.8%`, `−63.1%`, `+41%` |
| `formatClaimed(value)` | "Paper reports +41%" or "Paper gives no number" |
| `orMissing(value, fallback)`, `isMissing`, `MISSING` | Write missing values plainly, never as a bare "—" |
| `formatSignificant(value, 3)`, `roundNumbersInText(text)` | `84.9061` → `84.9`, including inside LLM prose |
| `humanizeMetric(id)` | `throughput_tokens_per_s` → "Throughput (tokens/s)" |
| `formatAcronyms(text)` | "Kv cache for llms" → "KV cache for LLMs" |
| `formatMath(text)`, `parseMath(text)`, `hasMath(text)` | `4^{-b}` → `4⁻ᵇ`, `\times` → `×` |
| `sanitizeText(raw, { keepNewlines })` | Strips ANSI codes, rewrites `0…+10%` as `0 to +10%`, converts LaTeX and rounds decimals |

`formatGainRange` (roofline) and `formatCI` now use "to" instead of "…".

## Checking your work: `npm run ux:check`

```sh
cd web && PAPERATLAS_WEB_PORT=5181 npm run dev            # your dev server (proxies /api to :8100, read-only)
npm run ux:check -- --base http://127.0.0.1:5181 --routes /experiments,/experiments/6 --vps 390,1024,1440
```

- The check is GET-only and aborts any other request. It writes full-page screenshots and JSON to
  `web/dev/screenshots/ux-check/` (gitignored).
- **It fails on:** document horizontal scroll (with the culprit element), elements past the viewport,
  text-on-text and sibling-box overlaps, SVG text overlapping, escaping its svg or rendered below 11 px,
  tooltips outside the viewport, under the header or covered, truncated numbers, a toast over the action
  bar, nav destinations unreachable, and `text-[<12px]` in the `--lint-strict` files.
- **It warns about:** text below 12 px, targets below 24 px, clipped or truncated text, native `title`
  attributes, and focus without a visible ring.
- Use `--save-baseline <file>` and `--baseline <file>` to fail only on regressions. `--no-tooltips` makes it
  faster. Add `--lint-strict <your files>` to make tiny-text classes in your own files fail.
- The dev-only route **`/__ux`** (`web/dev/UxLab.tsx`) renders every primitive with its edge cases. Run
  `--routes /__ux,/__ux?toast=1`.
