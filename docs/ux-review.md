# PaperAtlas console: UX review (phase 1 audit)

**Scope:** the web console under `web/` (React 19 + Vite + Tailwind v4), every route, at 1440, 1280, 1024, 768 and 390 px.
**Audience:** researchers, software developers, ML/AI experts, product managers, and VPs/directors. They share one presentation, with no per-audience views.
**Status:** audit only. This document changes no code; separate implementation sessions make the changes using the workstreams in [§6](#6-implementation-split).

**How the evidence was gathered (2026-11-24, live data on `http://127.0.0.1:8100`):**

- Headless Chromium (Playwright 1.65), GET-only: every non-GET request was aborted at the network layer, and the log shows 0 attempts.
- 23 routes × 5 viewports, saved as full-page screenshots plus a JSON overlap report per page. The IDs come from the live API: experiments 1–9, topic `decoding`, papers `arxiv:2606.24033` and `arxiv:2611.27561`, claims 168 and 544.
- 177 interaction-state screenshots: glossary tooltips on hover and focus, "Explain", "why?" and "Claim card" expansions, concept-map hover, the Gate 1 pick bar, and dialogs opened then cancelled (Start experiments, Run research scan, Merge, Re-run, Measure roofline).
- A programmatic detector (see [Appendix A](#appendix-a-how-overlaps-were-detected)) checked:
  - text-on-text intersections, clipped to overflow ancestors;
  - sibling box intersections;
  - elements overflowing the viewport, and horizontal scroll at the document level;
  - SVG `<text>` collisions;
  - tooltips: outside the viewport, clipped by an ancestor, or covered by the sticky header;
  - truncated text;
  - text under 12 px, and targets under 24 px.
- Every automated hit was checked by eye before it went into this document, and false positives were dropped.
- **Screenshots** live under `web/dev/screenshots/ux-audit/`, which is gitignored. The absolute path for other worktrees is
  `/Users/manish/.copilot/repos/copilot-worktrees/paperatlas/mbanitk-fictional-engine/web/dev/screenshots/ux-audit/`.
  Paths below are relative to that folder:
  - `<route>@<vw>.png`: full page
  - `report/<route>@<vw>.json`: detector output
  - `states/…`: interaction states
  - `svg/…`: diagram close-ups
  - `crops/…`: above-the-fold crops
- **Gate 2** (`awaiting_approval`) had no live instance during the audit. It is reviewed from code (`SpecGate.tsx`), and WS3's verification shows how to render it from a fixture without touching the backend.
- **The data is live**, so some states changed while the audit ran. Experiment #4 went from *tuning* to *awaiting decision*. The findings refer to what each screenshot shows.

---

## 1. Executive summary: the top 10 problems, ranked by impact

| # | Sev | Problem | Where | Why it matters for this audience |
|---|-----|---------|-------|----------------------------------|
| 1 | P0 | **Glossary tooltips are hidden or cut off.** The term tooltip (`absolute bottom-full left-0 z-20`) renders *under* the sticky header (`z-30`) whenever the term sits in the top ~80 px of the viewport. It goes off-screen at the top (y = −16 px), and at 390 px it runs off the right edge (right = 410–500 px). Inline glossary words use the native `title` attribute, which never shows on touch or keyboard. | Every claim surface: Recommendations, Claims, Claim detail, and the claim panel on Experiment detail. | The plain-language layer is how PMs and executives understand claims. Today its explanations fail exactly when people reach for them. [OV-01…04](#5-overlap--clipping-inventory) |
| 2 | P0 | **Diagram labels collide, and diagrams shrink to illegible sizes.** Edge labels are drawn on top of node labels ("runtime keys" over "Allocate block bits"), and parallel edge labels stack on the same spot, so one disappears ("Two small blocks" under "One large block"). The verdict chart's labels overlap and a marker line strikes through them. Text renders at **5.6 px** at 390 px (verdict chart) and about 4 px (concept map). | `FlowDiagram`, `ConceptMap`, `ImprovementChart`, on 8 routes. | Diagrams are the main tool for explaining a technique to non-specialists, and the chart is the main evidence at Gate 3. Collisions make both unreadable. [OV-05…18](#5-overlap--clipping-inventory) |
| 3 | P0 | **Gate 3 has no bottom line, and the primary button ignores the verdict.** Experiment #6 shows the claim check *Partial +2.8 %* next to the adoption check *Regression −63.1 %*. Nothing says "recommend: drop", **Merge** is still the green primary button, and the merge dialog doesn't restate the evidence. | `ExperimentDetail` + `VerdictPanel` + `VerdictV2`. | A VP or PM must be able to make the call in 10 seconds without reading tables. Today the visual design nudges toward the wrong decision. |
| 4 | P0 | **Recommendations (Gate 1) is a feed of very tall cards.** Each card is 880–1,160 px tall. The page is **27,681 px at 1440** and **59,310 px at 390**. The primer is open by default, and the before/after diagram is always shown. The decision number (**predicted gain *here***) is small and grey, while the paper's number is 28 px and green. | `Recommendations`, `ClaimStory`; also Claims (24,321 px). | Gate 1 is a comparison task: pick 1–2 of 30. Nobody can compare 30 items that are each a screen tall, and the most important number has the least visual weight. |
| 5 | P0 | **The 390 px layout breaks.** <br>• Page-level horizontal scroll on experiments #3 and #4: an `sr-only` span inside a `<th>` escapes its `overflow-x-auto` wrapper. <br>• The Experiments table hides Status, Verdict and Δ off-screen. <br>• The Gate 1 pick bar is 225 px tall (27 % of the screen) and permanently hides the last 41 px of the list. <br>• The main nav hides Research, Projects, System and the "needs you" count. <br>• Filters fill the first screen. | Layout, Experiments, ExperimentDetail, Recommendations. | Executives read on phones. The first screen at 390 px must carry the answer. [OV-20…22, 27](#5-overlap--clipping-inventory) |
| 6 | P0 | **Layering and wrapping defects in shared parts.** <br>• The verdict pill wraps onto two lines ("NOT / REPRODUCED"). <br>• Toasts (`z-50`, bottom-right) sit on top of the pick bar's **Start** button (178×28 px overlap). <br>• "See verdict ↓" and "#concept-map" anchors land under the sticky header. <br>• Result tiles truncate the *number itself* ("32.2–79.1%"). <br>• Metric names break mid-token. | `Badges`, `Toast`, `Layout`, `Explainers`, `ui`. | These are small defects, but they appear on every page and make the product feel unfinished to senior viewers. |
| 7 | P1 | **Colour carries contradictory meaning.** <br>• Green marks the *paper's* claim (not a result), and the adoption tile is always green, even when it says "Regression". <br>• Purple means the paper's numbers, merged, bundle, patent, throughput, TL;DR and Claim check all at once. <br>• Amber means both "needs you" and "partial". <br>• Red marks "unlikely" (a prediction of no gain) and "high effort", as well as real failures. | `ClaimStory`, `VerdictV2`, `Badges`, `lib/stages`, `lib/roofline`. | Executives read colour before words. Green must mean "good result measured here" and nothing else. |
| 8 | P1 | **Status and verdict wording is inconsistent, and summaries hide negative outcomes.** <br>• "Not reproduced" (verdict) vs "No gain" (adoption); "Partial" vs "Partially reproduced"; ALL-CAPS solid pills vs sentence-case chips. <br>• The Overview "Verdicts" tile reads "1 reproduced · 1 partial" while the other 4 of the 6 verdicts didn't reproduce or got worse. <br>• The Experiments list shows only the claim-check Δ, a green +2.8 %, for an experiment that is −63 % on the default workload. | Overview, Experiments, `lib/stages`, `lib/protocol`. | It erodes trust: summary views must be as honest as the detail. |
| 9 | P1 | **Raw expert strings leak into the plain layer.** <br>• LaTeX in titles: "4^{-b} penalty". <br>• Range notation "0…+10%"; "claimed —"; "vs the paper's —;". <br>• snake_case metrics with no plain label (`throughput_tokens_per_s`). <br>• Raw log lines in Overview "Live activity". <br>• A full Python traceback as the first content of a failed experiment. | Everywhere. | One presentation for all works only when the *first* layer is plain and the raw layer is one click away. |
| 10 | P1 | **Accessibility and interaction debt.** <br>• Text at 9–11.5 px everywhere: 64 elements at 10.5 px on Papers, and 27 at 10 px on Recommendations. <br>• `text-subtle` contrast is 3.45:1; white on amber (the PARTIAL pill and nav counter) is 3.14:1. <br>• About 50 % of interactive targets are under 24 px (128 of 262 on Recommendations). <br>• Hover-only concept-map details cause up to **+223 px** layout shift. <br>• Tabs have no arrow-key support. | `index.css`, `Badges`, `ConceptMap`, `ui.Tabs`, `Insights`, `Explainers`. | It fails WCAG 2.2 AA (1.4.3 contrast, 2.5.8 target size, 1.4.13 content on hover/focus) and hurts readability for everyone in a meeting room. |

**Fix order:** Workstream 0 (foundation: tokens, portal tooltips, badges, action bar, tables, layout) unlocks most of #1, #5, #6, #7, #8 and #10. Then five parallel workstreams fix the page-level problems (#2, #3, #4, #9 and the remaining mobile issues). See [§6](#6-implementation-split).

---

## 2. Design principles for this audience mix

The same screen must serve a VP who has 10 seconds and an ML engineer who has 10 minutes. These rules make that possible without separate views.

1. **Answer first, evidence on demand (BLUF).** Every page, card and gate opens with **one sentence and one number** that answer the question the screen exists for:
   - Gate 1: *Should we test this?*
   - Gate 2: *Is this a fair test?*
   - Gate 3: *Merge or drop?*
   - Claim: *What does it promise, and does it hold here?*

   Evidence (tables, diagrams, logs, raw spec) sits behind clearly labelled disclosures, ordered from summary to raw.
2. **The same order everywhere: What it is → Result → Confidence → Details.**
   - **What:** title + one plain sentence.
   - **Result:** the decision number, with its verdict or likelihood word.
   - **Confidence:** CI, likelihood, fidelity, sample size.
   - **Details:** explanations, diagrams, raw data.

   Cards, list rows, page headers and dialogs all follow this order (see [card anatomy, §3.4](#34-card-anatomy)).
3. **Plain layer first, expert depth one click away. Never remove numbers.**
   - Layer 1 (everyone) is plain words with the number in context: "+5 to +30 % faster decoding expected here".
   - Layer 2 (PM and lead) adds comparison and confidence: "vs the paper's 2.63× on an accelerator simulator · likely".
   - Layer 3 (experts) is the raw material: metric IDs, CIs, counters, the spec, logs.
   - Each layer is a superset of the one before it. Experts never lose information, and executives never start with raw data.
4. **Claimed ≠ predicted ≠ measured: three visual registers.**
   - **Paper's claim:** neutral ink plus a paper icon, labelled "Paper reports". Never green.
   - **Predicted here** (cost model): a *dashed* outline, labelled "Expected here".
   - **Measured here** (A/B): a *solid* tint, coloured by outcome.

   Anyone can tell at a glance whether a number is a promise, an estimate or a result.
5. **Colour means only one thing, and never stands alone.**
   - Green = good outcome measured or expected here. Red = harm or failure. Amber = caution, or needs your attention. Blue = in progress / info. Grey = neutral or none. Purple = merged (only).
   - Every coloured element also has an icon and a word.
6. **One vocabulary.** One word per concept across chips, tables, dialogs and copy (see [Appendix B](#appendix-b-ui-vocabulary)). Use sentence case. No ALL-CAPS pills.
7. **Density and whitespace rules.**
   - At most **one hero number per card**.
   - At most **3 tags visible** (then "+N").
   - Body text 14 px with lines ≤ 75 characters. **Nothing below 12 px**, including diagram text at its rendered size.
   - Gaps: 24 px between page sections, 12–16 px inside a card, 4 px between a label and its value.
   - Collapsed list items: ≤ 200 px tall on desktop and ≤ 280 px on mobile.
8. **Nothing overlaps, by construction.**
   - Floating UI goes through a **portal with collision detection**.
   - Sticky and fixed bars **reserve their own space** with CSS variables.
   - Numbers **never truncate**: wrap them or shrink the container instead.
   - Diagrams **reserve label space** or switch layout. They never scale text below the minimum.
9. **Decisions are explicit and honest.**
   - The *recommended* action is the primary button, and it follows the evidence.
   - Destructive or costly actions (GPU or LLM jobs, merges) always confirm, restate the evidence, and never get initial focus.
10. **Mobile is a reading device.** At 390 px the answer for each page is visible in the first 600 px. Tables become cards, filters collapse, and the stepper is compact. Pages never scroll horizontally.

---

## 3. Design-system foundation spec

Workstream 0 implements this section. Every value is a CSS custom property in `web/src/index.css` (`@theme`) so that Tailwind utilities and SVG code share it.

### 3.1 Spacing scale (4 px base)

| Token | px | Use |
|---|---|---|
| `1` | 4 | label ↔ value, icon ↔ text |
| `1.5` | 6 | chip gap, tight inline groups |
| `2` | 8 | between chips/tags, inside dense rows |
| `3` | 12 | inside cards (mobile padding), stacked items in a card |
| `4` | 16 | card padding (desktop), list-row padding |
| `6` | 24 | between cards/sections on a page |
| `8` | 32 | page header ↔ content |

Control heights: buttons 28 px (`sm`), 32 px (`md`) and 40 px (`lg`). On screens narrower than 640 px, primary actions use **44 px**. Checkboxes, radios and icon buttons have a **≥ 24 × 24 px hit area**, using padding if the glyph is smaller.

### 3.2 Type scale (no ad-hoc sizes)

Remove every `text-[9px]`, `[9.5px]`, `[10px]`, `[10.5px]`, `[11px]`, `[11.5px]`, `[13px]` and `[15px]`/`[28px]`, and use these tokens instead:

| Token (Tailwind v4 `--text-*`) | Size / line | Weight | Use |
|---|---|---|---|
| `text-caption` | 12 / 16 | 400–600 | labels, chips, table headers, legends, diagram labels at rendered size, timestamps |
| `text-body` | 14 / 20 | 400 | default body (keep `body { font-size: 14px }`) |
| `text-body-lg` | 16 / 24 | 500 | card titles, one-line plain headlines |
| `text-title` | 20 / 28 | 600 | detail-page object title (h1 on detail pages), section headings |
| `text-page` | 24 / 32 | 600 | page title (h1 on index pages) |
| `text-metric` | 28 / 34 | 600, `tabular-nums` | the one hero number per card/panel |
| `text-metric-sm` | 20 / 28 | 600, `tabular-nums` | stat tiles, secondary numbers |

- Eyebrows (small labels above a title) are 12 px sentence case, `text-muted`, one per block. **No uppercase + tracking.**
- SVG: compute the rendered font size as `fontSize × (renderedWidth / viewBoxWidth)`. It must be **≥ 11 px**. If a layout would go below that, switch layout (vertical, or one lane at a time) or scroll. Never shrink further.

### 3.3 Colour: base and semantic tokens

Keep the GitHub-Primer base palette that's already in `index.css`. Add semantic aliases and stop using raw tones for meaning:

| Semantic token | Base | Means | Never use for |
|---|---|---|---|
| `positive` / `-subtle` / `-emphasis` | success `#1a7f37` / `#dafbe1` / `#1f883d` | good outcome measured or expected **here** | the paper's claim, "low effort", topics |
| `negative` / … | danger `#d1242f` / `#ffebe9` / `#cf222e` | harm: regression, failed, quality guardrail broken | "unlikely", "high effort", "requires CUDA" (use `caution`) |
| `caution` / … | attention `#9a6700` / `#fff8c5`; badge bg uses **dark text on `#fff8c5` with a `#bf8700` border** | mixed, partial, marginal, needs your attention | text on solid `#bf8700` (3.14:1, fails) |
| `info` / … | accent `#0969da` / `#ddf4ff` | in progress, links, selected, **predicted** (dashed) | outcomes |
| `neutral` / … | `#59636e` / `#eff2f5` | none / no effect / queued / not estimated | — |
| `merged` | done `#8250df` / `#fbefff` | merged (only) | paper numbers, bundle mode, patents, themes, TL;DR |
| `reference` | fg `#1f2328` on canvas-subtle + paper icon | the paper's claimed number | — |

- **Text contrast:** `text-subtle` (`#818b98`, 3.45:1) may only be used for disabled or decorative text. All readable text uses `text-muted` (`#59636e`, 6.1:1) or darker. Keep the nav-active underline `#fd8c73`, but add `font-semibold` and `aria-current` (already done) so the state doesn't rely on colour alone.

**Semantic mappings.** A single source of truth, the new `web/src/lib/semantics.ts`, holds the label, tone, icon and description for each value. Each value has one label, tone and icon:

| Domain | Value → label · tone · icon |
|---|---|
| **Experiment status** | `awaiting_approval` → "Needs your approval" · caution · gate <br>`awaiting_decision` → "Needs your decision" · caution · gate <br>`planning`, `approving`, `building`, `smoke_testing`, `tuning`, `running`, `judging`, `finalizing` → present-tense verb · info · pulsing dot <br>`queued`, `waiting_gpu`, `blocked`, `cancelling` → neutral · clock <br>`merged` → "Merged" · merged · merge <br>`dropped`, `rejected`, `cancelled` → neutral-muted · minus <br>`failed` → "Failed" · negative · x |
| **Claim check (verdict)** | `reproduced` → "Reproduced" · positive · check <br>`partial` → "Partly reproduced" · caution · half-circle <br>`not_reproduced` → "Not reproduced" · neutral · equals <br>`regression` → "Worse than baseline" · negative · arrow-down <br>`inconclusive` → "Inconclusive" · neutral · question |
| **Adoption check** | `worth_adopting` → "Worth adopting" · positive · check <br>`small_gain` → "Small gain" · caution · half-circle <br>`not_reproduced` → "No measurable gain" · neutral · equals <br>`regression` → "Worse than default" · negative · arrow-down <br>`inconclusive` → "Inconclusive" · neutral · question |
| **Predicted here (likelihood)**, dashed outline | `likely` → "Likely gain" · positive <br>`marginal` → "Small or no gain" · caution <br>`unlikely` → "Unlikely to help" · **neutral** (not red) <br>`unknown` → "Not estimated" · neutral |
| **Diagnosis** | Keep the existing labels in sentence case. Tone is **neutral** for every explanation category; reserve negative for `implementation_suspect`. |
| **Gain/loss (Δ)** | Significant better → `positive` + ↑ + "better". Significant worse → `negative` + ↓ + "worse". Not significant → `neutral` + "no clear change" (replaces today's `opacity-60` fade). Always show the sign. |
| **Effort / risk** | Neutral dots with words ("Effort: low"). No red/green: effort isn't success. |

### 3.4 Card anatomy

Use this anatomy for every card and list row: recommendation, claim, experiment row, topic, paper, verdict tile, stat tile.

```
┌─────────────────────────────────────────────────────────────────────┐
│ [glyph] Eyebrow: type · #id · source/date             [Status chip] │ 1 WHAT
│ Title (16/24 semibold, ≤ 2 lines, never truncated in detail views)  │
│ One plain sentence (14/20, ≤ 2 lines, clamp + "more" in lists)      │
│ ┌ Answer ─────────────────────────┐  Confidence / qualifier (12px)  │ 2 RESULT
│ │ +5 to +30 % decode   [Likely]   │  cost model · roofline 10 h ago │ 3 CONFIDENCE
│ └─────────────────────────────────┘  Paper reports 2.63× (sim)      │
│ tag · tag · tag  +2                                                 │ context
│ ─────────────────────────────────────────────────────────────────── │
│ ▸ Explain   ▸ Evidence   ▸ Raw card           [secondary] [PRIMARY] │ 4 DETAILS + actions
└─────────────────────────────────────────────────────────────────────┘
```

- The Answer block has one variant per register: `measured` (solid tint by outcome), `predicted` (dashed info outline) and `claimed` (reference: neutral ink and paper icon).
- Disclosures always use the same verbs and order:
  - **Explain:** plain-language deep dive, with the primer, before/after flow and steps.
  - **Evidence:** numbers, tables and the diagram.
  - **Raw:** the claim card, JSON, logs.
- Actions sit on the right. The primary action comes last and is the **recommended** one.
- Padding is 16 px on desktop and 12 px below 640 px. The radius is 8 px. Borders are `line`. A selected card gets an `info` ring; a gate that needs you gets a `caution` ring.
- WS0 exports: `CardHeader {eyebrow, title, summary, status, actions}`, `AnswerBlock {register, value, unit, label, tone, confidence}`, `Disclosure {label, defaultOpen}`, and `ChipRow {items, max=3}`.

### 3.5 Tooltip and popover approach (never overlaps, never clips)

**Decision:** adopt **`@floating-ui/react`** (about 10 kB gzipped, MIT). It's the right call here because:

- Tooltips must escape `overflow` and container-query stacking contexts. `ClaimOverview`'s `@container` creates both, and the concept map scrolls inside an `overflow-x-auto` box.
- Tooltips must avoid the sticky header.
- Tooltips must work by hover, focus *and* tap.

The native Popover API plus CSS anchor positioning isn't yet reliable across browsers for flip and shift.

Three primitives in the new `web/src/components/Tooltip.tsx`:

| Primitive | Trigger | Content | ARIA | Use for |
|---|---|---|---|---|
| `Tooltip` | hover (300 ms open / 100 ms close delay), focus | ≤ 1 short sentence, non-interactive | `aria-describedby`, `role="tooltip"` | icon buttons, truncated tags, chart marks |
| `InfoPopover` | click / tap / Enter / Space; also opens on hover for mouse users | short definition + optional "Learn more" link; interactive | `role="dialog"`, `aria-expanded`, focus returns to trigger, Esc closes, click outside closes | glossary definitions, prediction reasons, formula explanations ("score = fit × …"), blocker details |
| `Term` | inline text (dotted underline, `button` semantics) wrapping `InfoPopover` | glossary meaning | as above | replaces `<abbr title>` in `GlossaryText` and the absolute-positioned `TermChip` tooltip |

The middleware stack is mandatory and identical for all three:

```ts
const headerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 64
useFloating({
  placement: 'top',
  strategy: 'fixed',
  whileElementsMounted: autoUpdate,
  middleware: [
    offset(6),
    flip({ padding: { top: headerH + 8, bottom: actionBarH() + 8, left: 8, right: 8 }, fallbackAxisSideDirection: 'start' }),
    shift({ padding: 8 }),
    size({ padding: 8, apply({ availableWidth, availableHeight, elements }) {
      Object.assign(elements.floating.style, { maxWidth: `${Math.min(320, availableWidth)}px`, maxHeight: `${availableHeight}px` })
    } }),
    arrow({ element: arrowRef }),
    hide({ strategy: 'referenceHidden' }),   // hide when the trigger scrolls under the header
  ],
})
// always render inside <FloatingPortal> with z-index var(--z-popover)
```

Rules:

- **Never** use the native `title` attribute for information a user needs. `title` is allowed only on truncated labels as a duplicate of an accessible tooltip.
- Floating content renders inside a portal and is never a child of a clipping or `contain`ed ancestor.
- On touch, `Tooltip` content must also be available through an `InfoPopover` or inline text. There are no hover-only facts.
- The z-index scale, defined as CSS variables, is: sticky header `--z-header: 30`, action bar `--z-actionbar: 35`, popover/tooltip `--z-popover: 40`, toast `--z-toast: 60`. Dialogs use the browser's top layer.

### 3.6 Chips, badges and tags

| Kind | Look | Content | Rules |
|---|---|---|---|
| **Status chip** (`StatusChip`) | subtle tint, 20 px tall, dot or icon + word | experiment/job/scan status | sentence case, `whitespace-nowrap`, never truncated |
| **Outcome badge** (`OutcomeBadge kind=verdict\|adoption\|likelihood\|diagnosis`) | subtle tint + 1 px border in tone; **predicted = dashed border** | icon + word (+ optional value) | replaces the solid uppercase `VerdictBadge`. Contrast ≥ 4.5:1, nowrap, min-width so it never wraps |
| **Tag** (`Tag`) | neutral outline, no fill | category, topic, mode (bundle/chain), doc type, requirement | max 3 visible + "+N" (InfoPopover lists all); may truncate at 24 ch with `Tooltip`; links get hover border only |
| **Code token** (`CodeToken`) | `code-inline`, nowrap | flag names, metric IDs, branches | always paired with a plain label where one exists (`humanizeMetric`) |

Avoid colour for tags. Mode "Bundle" is no longer purple and "patent" is no longer purple; both are neutral tags with an icon. "Requires CUDA" uses `caution`, not `negative`.

### 3.7 Icon policy

- Use one set: the `Glyph`/`*Icon` components in `Icons.tsx` (16 px grid, 1.5 stroke, `currentColor`), at sizes **12, 14, 16 and 20** only.
- **No Unicode pictographs as meaning carriers.** Replace ★ (primary metric), ↻ (re-run), ‹/› (code), ≈ (approximate), ↑/↓ in tables, → (prerequisite arrows), ⚠ and "HF ↑" with icons from the set. Add `star`, `rerun`, `code`, `approx`, `arrow-up`, `arrow-down`, `half` and `equals` if they're missing.
- Every icon is either decorative (`aria-hidden`, with text next to it) or labelled (`aria-label`). Don't use an icon alone for status.

### 3.8 Table pattern

- Wrap every table in `TableScroll`, which is **`relative overflow-x-auto`**. The `relative` fixes the escaping `sr-only` header bug (OV-21). Add edge shadows when the content scrolls, plus `tabIndex=0` and `aria-label`.
- Header cells: 12 px `text-muted`, sentence case. Numeric columns are right-aligned and `tabular-nums`. Rows are at least 40 px tall. Whole-row links use the "stretched link" pattern, which is keyboard reachable, instead of `onClick` on `<tr>`.
- **Below 768 px, list tables become cards** (Experiments, Jobs): title, status, outcome and Δ, then the CTA. Data tables (metrics, tuning, counters) keep horizontal scroll, but their first column is `sticky left-0` and a "Scroll →" hint shows when they overflow.
- Never put the decision column (verdict or Δ) last on mobile.

### 3.9 Stat-tile pattern (`StatTile`)

`label` (12 px muted, sentence case) → `value` (`text-metric-sm`, tabular) → `context` (12 px, ≤ 2 lines, wraps, never truncated) → optional `delta` or mini-bar. The whole tile is a link when it navigates, with the same hover treatment everywhere. Use this one component for:

- Overview stats
- Verdict quality and environment numbers
- Topic KPIs (`KpiRow`)
- Roofline tiles
- Paper key results (`ResultTiles`)
- Claim key numbers (`KeyNumbers`)

The **value never truncates**: long values wrap, or the grid drops a column.

### 3.10 Empty, loading and error states

- **Loading:** skeletons shaped like the content (card, row, chart) rather than a centred spinner for any block taller than 120 px. Live sections show "Updating…" inline and don't blank out.
- **Empty:** a one-sentence reason, one primary action, and optionally one secondary link. Use sentence-case titles, for example "No gates are waiting for you".
- **Error:** a plain-language sentence first ("The lab-api didn't respond."), then **Retry**, then a "Technical details" disclosure with the raw message, status and path. Experiment failures follow the same pattern: "Smoke test failed: the benchmark crashed before measuring", then *Show error output* (the traceback).
- **Stale data:** when the gateway is unreachable, show the banner (it exists today), and dim stat values with "as of 3 min ago".

### 3.11 Focus and keyboard

- A visible focus ring on every interactive element, including SVG nodes: 2 px `info` outline, 2 px offset. `:focus-visible` exists today; make sure no component sets `outline-none` without a replacement.
- **Tabs:** roving `tabIndex`, ←/→/Home/End, `aria-controls` ↔ `aria-labelledby`.
- **Dialogs:**
  - Initial focus goes to the first form field, or to **Cancel** for confirmations that are destructive or costly.
  - In the audit, focus went to the "×" button, while the `ConfirmDialog` code requests `autoFocus` on Confirm. Make focus explicit with an `initialFocus` prop.
  - Esc closes, and focus returns to the trigger.
- **Concept map:** Tab moves node to node in reading order. Enter opens the claim. Focus shows the same details as hover, in a panel of **fixed** height or in an `InfoPopover`. No layout shift.
- **Skip link:** keep it. Add `scroll-padding-top: calc(var(--header-h) + 12px)` on `html` so that anchors and focus never land under the header.

### 3.12 Responsive breakpoints

| Range | Layout rules |
|---|---|
| **< 640 (base, test at 390)** | Single column. Compact nav: logo, current section, "Needs you" pill, and a **Menu** button that opens all 6 sections. Filters collapse to "Filters (n)". Tables become cards. Compact stepper ("Step 8 of 8 · Merge or drop: waiting for you"). Sticky action bars are one line. Diagrams use vertical layout, or one lane with a lane switcher; labels ≥ 11 px rendered. Card padding 12 px. Primary buttons 44 px. |
| **640–1023** | Two columns where every card is ≥ 320 px. Aside columns stack *below* the main content, and the answer stays above. |
| **1024–1279** | Main + aside (2:1). Diagrams horizontal if their natural width fits at ≥ 11 px text; otherwise vertical. |
| **≥ 1280** | Same, in a container with `max-w-7xl` (1280). Never more than 3 dense cards per row. |

**Global invariant:** `document.documentElement.scrollWidth <= innerWidth` on every route at every width. The UX check enforces it (Appendix A).

---

## 4. Findings by page and shared component

Each finding has an ID, a severity (**P0** = overlap or broken, **P1** = confusing, **P2** = polish), a screenshot, the problem, and the fix, including copy. The owning workstream is in brackets.

### 4.1 Global shell: `Layout.tsx`, `index.css`, `Toast.tsx`, `Dialog.tsx` [WS0]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| G-1 | P1 | `states/rec-fold@390.png` | At < 640 px the 6-item nav scrolls sideways with no affordance. Research, Projects and System, and the "5 waiting" counter, are off-screen, and `LiveDot` is hidden below `md`. | Compact nav per §3.12. Show "Needs you 5" as a persistent pill next to the logo on every page. The Menu sheet lists all sections with their counters. |
| G-2 | P0 | `svg/anchor-gate-under-header@1440.png` | In-page anchors (`#gate` "See verdict ↓" / "Review spec ↓", `#concept-map`, PaperDetail `scrollIntoView`) put the target's top at y = 0, under the 59 px sticky header. | Set `--header-h` from the header's height (a ResizeObserver, or a constant 57 px plus the banner), then `html { scroll-padding-top: calc(var(--header-h) + 12px) }`. Calls to `scrollIntoView` inherit it. |
| G-3 | P0 | `states/rec-pickbar-toast-sim@1440.png`, `…@390.png` | The toast stack (`fixed right-4 bottom-4 z-50`, 380 px wide) covers the pick bar's **Start 2 experiments** (178×28 px) and **Clear** buttons. Toasts appear right after Gate 1 actions, exactly when the bar is in use. (Simulated in the screenshot with the real `Toast.tsx` classes.) | Toasts sit at `bottom: calc(var(--action-bar-h, 0px) + 16px)`. On mobile they move to the top-centre below the header. `role="status"` stays. Error toasts persist until dismissed. |
| G-4 | P2 | — | `ConfirmDialog` sets `autoFocus` on Confirm. In the audit, the browser focused "×" instead (the "Start experiments", "Merge" and "Measure roofline" dialogs), so the behaviour is accidental. | Add an `initialFocus` prop: Cancel for `danger` or costly actions, and the first field for forms. Document it in `Dialog.tsx`. |
| G-5 | P2 | — | The footer reads "data from the research-api and lab-api via the gateway": developer jargon on every page. | "PaperAtlas · live data · [System status](/system)". |
| G-6 | P1 | `report/*.json` → `tinyText` | Font sizes of 9, 9.5, 10, 10.5, 11, 11.5, 13, 15 and 28 px are scattered through the code (64 elements at 10.5 px on Papers alone). | Use the type scale from §3.2. A lint rule (grep in `ux:check`) should fail the check on any `text-[` with a value below 12 px. |

### 4.2 Overview `/` [WS5]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| O-1 | P1 | `overview@1440.png` | The six stat tiles all have equal weight, and "Needs you" comes **last**. The page has no one-line state of the world. | Add an answer line under the title: **"5 decisions are waiting for you · 3 experiments running · 1 of 6 claims reproduced so far."** Reorder the tiles: Needs you (caution ring) → In progress → Outcomes → the research funnel (Topics → Papers → Claims), with the funnel as one compact row. |
| O-2 | P1 | `overview@1440.png` | The "Verdicts 6" tile says "1 reproduced · 1 partial" and hides the other four. At capture time those were 2 *not reproduced* and 2 *worse than baseline*. The tile isn't clickable. | Show a stacked outcome bar with all 5 outcomes, a legend in words, and a link to `/experiments?tab=all`. Copy: "6 verdicts: 1 reproduced, 1 partly, 2 not reproduced, 2 worse". |
| O-3 | P1 | `overview@1440.png` | In the Needs-you rows, Gate 3's icon is green (success), Gate 2's is amber and Gate 1's is blue: three colours for one meaning. Each row shows only the claim-check verdict. | Every gate row gets the `caution` gate icon. Row copy: "Decide: merge or drop" / "Approve the test plan" / "Pick claims to test". Show the **recommendation** chip from X-1 ("Suggest: drop") and both outcomes in a single line, for example "Claim partly held +2.8 % · Adoption worse −63 %". |
| O-4 | P2 | `overview@1440.png` | "In progress" rows show "claimed —" when the paper gives no number. | Hide it when null. Otherwise show "Paper claims +41 %". Add "Expected here +5 to +30 %" when there's a prediction. |
| O-5 | P2 | `overview@1440.png` | "Live activity" shows raw lines ("copilot: ✕ Edit Edit src/inference_lab/…", "[bench] round 13 variant: ttft=158.2ms …"). | Group the lines by experiment and show a human summary first ("#4 A/B test · round 13 of 20 · variant"). Raw text moves into a per-item "details" disclosure (`EventTimeline`, WS3). Rename the card "Live activity" → "What's happening now". |
| O-6 | P2 | `overview@1440.png` | Titles render raw LaTeX ("4^{-b} penalty"). The description hard-codes "inference-lab". | Use `MathText` (WS0) for titles. Take the project name from the API. |
| O-7 | P2 | `report/overview@1024.json` (46 truncations) | Gate, in-progress and activity titles truncate with no way to read the full text at 1024 px. | Clamp to 2 lines instead of truncating to 1. Truncated labels get a `Tooltip`. |

### 4.3 Recommendations `/recommendations` (Gate 1) [WS1; diagrams WS2]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| R-1 | P0 | `recommendations@1440.png`, `states/rec-card1@1440.png`; heights in `states/_states.json` | Each card always renders the hero, primer (open on card 1), "Usual approach vs the paper's idea", the before/after flow diagram, the rationale, meters and actions. That's **880–1,160 px per card**: the page is 27,681 px at 1440 and 59,310 px at 390. You can't compare cards. | **A compact card per §3.4, collapsed by default (≤ 200 px):** <br>1. ☐ #rank · Title · paper · date. <br>2. Plain headline (1 line). <br>3. **Answer** (right-aligned, predicted register): "Expected here: **+5 to +30 %** decode speed · Likely gain". <br>4. "Paper reports 2.63× inference speed (accelerator sim)" in the reference register, plus `Fit high · Effort low · Risk medium · Lossless`. <br>5. Actions: **Explain ▸** (primer, usual vs paper's idea, flow, key numbers, paper vs here, steps), **Evidence ▸** (prediction reasons, claim card), and the experiment status link. <br>Remove `primerOpen` on the first card. |
| R-2 | P0 | `states/rec-fold@1440.png` | The hierarchy is inverted. "THE PAPER REPORTS **up to 3.4×**" is a 28 px green hero. "PREDICTED HERE **0…+10 %** marginal" is grey, smaller, and sits to the side. Gate 1 is decided on *expected gain here*. | Make the predicted number the primary answer, in the dashed info register. The paper's number becomes a secondary line in neutral ink with a paper icon, never green. Copy: "Predicted here · Apple M5 Pro" → "**Expected on inference-lab (M5 Pro)**". "why?" → "Why this estimate?", opening an `InfoPopover` with the reasons. |
| R-3 | P1 | `states/rec-card1@1440.png` | The meta row reads "▬ score **0.290** fit ▬ effort ●○○ risk ●●○": the labels float between unlabelled bars at 11 px, so "fit" seems to belong to "score". The score formula is in a native `title`. | Use a labelled group: "**Match 0.29** ⓘ · Fit: high · Effort: low · Risk: medium". Each value is a word plus neutral dots (§3.3). ⓘ opens an `InfoPopover`: "Match = fit × (0.4 + expected gain) ÷ effort cost". |
| R-4 | P0 | `states/rec-pickbar-bottom@390.png`, `states/rec-pickbar-toast-sim@390.png` | At 390 px the fixed pick bar lists every selected title and grows to **225 px** (27 % of the viewport). The page's `pb-24` (96 px) doesn't cover it, so the last card's actions stay hidden under the bar (41 px) even at full scroll. | Use `StickyActionBar` (WS0): one line, "**2 selected** · Review & start →", 56 px tall. The bar sets `--action-bar-h`, the page pads by it, and toasts sit above it. The titles appear in the Start dialog. |
| R-5 | P1 | `states/rec-fold@390.png` | On mobile the filters (search, topic, category, include blocked, predicted, sort) take up the whole first screen. The first card starts at y ≈ 640. | Keep search visible. Put the rest behind "Filters (n) ▾" (a sheet on mobile, inline on desktop), and show the active filters as removable tags. |
| R-6 | P1 | `report/recommendations@1440.json` → `smallTargets` (128/262 < 24 px) | The selection checkbox is 18 px, and its label is only the title text. | Use a 24×24 hit area. Copy for the screen-reader label: "Select for testing". When selected, the card gets the `info` ring plus the text "Selected". |
| R-7 | P1 | `states/rec-start-dialog@1440.png` | The Start dialog reads "not quantified" (the paper's claim) and "0…+10 %". It doesn't state the cost of each choice. | Copy: "not quantified" → "Paper gives no number". Ranges are "0 to +10 %". Add one line per pick: "Creates 1 experiment · builds on a new branch · nothing is merged without Gate 3". |
| R-8 | P2 | `states/rec-card1@1440.png` | "Why for this project:" is a purple sparkle line that competes with the answer. | Move it into the Answer block's qualifier ("Why: optional MLX draft-tree; measured against spec_decode"), clamped to 2 lines; the full text goes in Explain. Remove the purple. |
| R-9 | P2 | `states/rec-card1@1440.png` | "Experiment #6 · Needs decision" and "Already being tested in experiment #6." say the same thing twice. | One status line: "Being tested in **#6** · Needs your decision →". |
| R-10 | P2 | `states/rec-scan-dialog@1440.png` | Scan dialog jargon: "Distill limit", "heuristics only". | "Max papers to summarise (1–500)". "Use the LLM" → "Write summaries with the LLM (uncheck for keyword heuristics, no API key needed)". |
| R-11 | P0 | see [OV-10, OV-11, OV-12](#5-overlap--clipping-inventory) | Flow-diagram collisions inside cards. | WS2. Collapsing the flow into Explain (R-1) also removes 30 always-visible diagrams. |

### 4.4 Experiments list `/experiments` [WS3]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| E-1 | P0 | `crops/experiments-top@1440.png` | The verdict pill wraps onto two lines ("NOT / REPRODUCED") at 1024–1440 px, an uppercase pill broken in half. | Use `OutcomeBadge` (nowrap, sentence case) and give the column `min-w` = the widest label. Copy: "Not reproduced". |
| E-2 | P0 | `crops/experiments-top@390.png` | At 390 px only "#" and "Concept" are visible. Status is cut, and Stage, Verdict, Δ and Updated are off-screen with no scroll cue. | Below 768 px, render cards: **title**; status chip; "Claim: Partly reproduced +2.8 % · Adoption: Worse −63 %"; gate CTA ("Decide →"). |
| E-3 | P1 | `crops/experiments-top@1440.png` | Δ shows only the **claim-check** median. Experiment #6 shows a green **+2.8 %**, but its adoption check is **−63.1 %**. The list misleads. | Rename the column to "Outcome" and show two lines: "Claim: ◐ Partly reproduced +2.8 %" / "Here: ↓ Worse than default −63.1 %". **Depends on the API:** add `adoption_verdict` and `adoption_median_delta_pct` to `ExperimentSummary`. They already exist on `IterationEntry` (`api/types.ts:725`). Until the lab-api ships them, show the claim line only, labelled "Claim check". |
| E-4 | P2 | `crops/experiments-top@1440.png` | Header "Concept" for experiments. "claimed —". "Δ measured". | "Experiment", "Outcome", "Updated". Omit the claimed line when it's null; otherwise "Paper: +41 %". |
| E-5 | P2 | — | Rows navigate with `onClick` on `<tr>` (mouse-only beyond the title link). `Tabs` has no arrow keys. | Use the stretched link (§3.8) and the keyboard support in WS0's `Tabs`. |

### 4.5 Experiment detail `/experiments/:id` (Gates 2 and 3) [WS3; chart WS2]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| X-1 | P0 | `crops/exp6-top@1440.png`, `states/exp6-verdict@1440.png` | **There's no bottom line.** The banner, the claim-check tile (Partial +2.8 %) and the adoption tile (Regression −63.1 %) each say something different. The recommended decision is never stated. **Merge** is the green primary button even when adoption regresses. | Add a **Decision summary** block, the first thing under the title on every judged experiment: <br>**"Recommendation: Drop.** On your default workload it's **63 % slower** (throughput, concurrency 4). The paper's claim partly held here (+2.8 % vs a +5 % target)." <br>Then: two `AnswerBlock`s (Claim check, Adoption check), each with CI and fidelity; then the actions, with the **recommended action as the primary button** and the other one secondary. Recommendation logic: adoption `worth_adopting` with quality OK → Merge. `regression`, or a failed quality check → Drop. `small_gain`, `not_reproduced` or `inconclusive` → "Your call", with no primary styling and the reason stated. |
| X-2 | P1 | `crops/exp6-top@1440.png` | The Gate 3 banner reads "The judge measured +2.8 % vs the paper's **—**;" when the paper gives no number. | When the claim is null: "The paper gives no number to compare with." The banner becomes a short link to the Decision summary: "Gate 3: your decision is needed. See the recommendation ↓". |
| X-3 | P1 | `states/exp6-verdict@1440.png` | The Claim-check tile is always purple-tinted and the Adoption tile always green-tinted, whatever the outcome (green "Regression"). | Use neutral containers. Tone comes only from the `OutcomeBadge` and the Δ (§3.3). |
| X-4 | P1 | `states/exp6-merge-dialog@390.png` | The Merge dialog doesn't restate the evidence, and doesn't warn when adoption regresses. | Add a recap line: "Claim: Partly reproduced +2.8 % · Here: Worse than default −63.1 %". When the recommendation is Drop, show a caution banner: "Merging puts code on `main` that makes the default workload slower when the flag is on. The flag stays off by default." The button reads "Merge anyway". |
| X-5 | P1 | `states/exp6-verdict@1440.png` | The diagnosis is a wall of LLM text with numbers like "84.9061 tokens/s", followed by the mechanism, tuning, per-metric and quality sections, all expanded. | The diagnosis shows its summary sentence, plus the chip and "Show full analysis". The rest is grouped under **Evidence ▸** (per-metric, mechanism counters, tuning, iterations) and **Run details ▸** (quality, environment, report). Format numbers through `formatNumber` (≤ 3 significant digits in prose), via a WS0 helper. |
| X-6 | P1 | `states/exp6-fold@390.png` | The header packs in the title, status chip, ALL-CAPS verdict pill, category, mode, flag, branch, paper and source. At 390 px it's about 300 px tall before any result. | Title, then **one** status line ("Needs your decision · Partly reproduced"), then the Decision summary. Flag, branch, paper and mode move to a "Details" row: a key–value list, collapsed on mobile. |
| X-7 | P1 | `states/exp6-fold@390.png` | On mobile the 8-step stepper becomes 8 stacked rows (~400 px) above the result. | Below 640 px, use the compact stepper: `MiniStages` plus "Step 8 of 8 · Merge or drop: waiting for you". The full list moves into a disclosure. |
| X-8 | P1 | `states/exp6-claim-under-test@1440.png` | "Claim under test" repeats the full claim story (hero, primer, usual vs paper, a before/after flow squeezed into the ⅓ column) on every experiment. | Use a compact claim summary (headline, "Paper reports…", "Expected here…") with **Explain ▸** and "Open claim →". |
| X-9 | P0 | `experiment-4-tuning@390.png` (`report/…json`: `scrollWidth` 548) | Page-level horizontal scroll at 390 px on #4 and #3. The cause is `TuningTable`'s `<th><span class="sr-only">Chosen</span></th>`: the `sr-only` span is absolutely positioned against the nearest positioned ancestor, which lies *outside* the `overflow-x-auto` wrapper. | Use `TableScroll` (WS0, `relative overflow-x-auto`) for every table in `VerdictPanel`, `VerdictV2`, `Sections` and `Protocol`. Add the regression to `ux:check`. |
| X-10 | P2 | `experiment-6-partial@390.png` | Secondary-metric `code` chips break mid-token across lines (`throughput_tokens_per_s`). | Use `CodeToken` (nowrap) inside a flex-wrap row, with a plain label next to each: "Throughput (tokens/s)". |
| X-11 | P1 | `crops/exp7-failed-top@1440.png` | A failed experiment shows a raw Python traceback as its first content, and the timeline repeats it in red. | "**Smoke test failed:** the benchmark crashed before measuring (exit 1 in `bench/runner.py`)." + **Retry** + "Show error output ▸". Timeline lines clamp to 2 with "more". |
| X-12 | P1 | code: `SpecGate.tsx` (no live Gate 2) | Gate 2 opens straight into an editable form (hypothesis, flag, metric…). The test plan's summary (`ProtocolSummary`) comes *after* the form, and the decision buttons sit at the bottom of a long card. | Order: **"Test plan at a glance"** (what we test, the success bar, the workload and model, rounds and expected duration, expected gain, fidelity) → **Approve and start build** (primary), *Request changes*, ⋯ *Reject* → "Edit plan ▸", which reveals the form and protocol editor. Unsaved edits show in a sticky bar: "2 unsaved changes · Save · Approve with edits". Copy: "Request revision" → "Request changes"; "Approve" → "Approve and start build". |
| X-13 | P2 | `crops/exp6-top@1440.png` | **Cancel experiment** (danger) sits next to **Re-run** in the header, even while a gate is open. | Put Re-run, Retry and Cancel in a "⋯ More" menu, except when an action is the page's main next step (Retry on failed). |
| X-14 | P2 | `states/exp6-verdict@1440.png` | Mechanism change colours are + purple and − blue, which carry no meaning. A table uses ★ for the primary metric. | Use neutral text with ↑/↓ icons. The primary metric gets a "Primary" tag instead of ★. |
| X-15 | P0 | `crops/exp6-top@1440.png`, `svg/improvement-chart-*.png` | Chart label collisions and 5.6 px text. | WS2 (OV-05…07). |

### 4.6 Research shell `ResearchLayout.tsx` [WS4]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| RL-1 | P1 | `crops/research-claim-168-top@1440.png` | Detail pages (topic, paper, claim) render under the section's h1 "Research" (24 px) and its tabs, so the object's own title is an h2 at 20 px. The hierarchy is upside down, and about 180 px is spent before the content starts. | On detail routes, drop the section header and show a breadcrumb ("Research / Claim cards / #168"), then the object title as the **h1** (`text-title`). Keep the tabs on index routes only. |

### 4.7 Topics `/research/topics` and topic detail [WS4]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| T-1 | P1 | `crops/research-topics-top@1440.png` | Topic names are raw cluster keywords ("Kv" twice, "Cache", "Video"), and the descriptions are auto-generated ("Recent work in 'KV-cache management & compression' about kv, cache, kv cache."). | Title = the explainer's title, or *seed* + top key phrase, with acronyms fixed (KV, LLM) and duplicates numbered (`displayTopicName` in WS4, reusing WS0's `formatAcronyms`). Description = `explainer.summary`; hide it if there's only the auto text. |
| T-2 | P2 | `research-topics@390.png` (`dt.truncate` "HF UPVOTES") | The KPI labels are 10.5 px uppercase and get truncated. Tiny spark bars have no axis. | `StatTile` in a 2×2 grid. Labels: "Papers", "With code", "Citations", "Hugging Face upvotes". Spark: "Papers per month (last 6)". |
| T-3 | P2 | `crops/research-topics-top@1440.png` | The card footer has four links (Papers · Recommendations · Details →). | The card title is the link. Keep "Papers" and "Claims to test" as secondary links. |
| T-4 | P2 | `research-topic-decoding@1440.png` | "Relevance for a single Apple Silicon server" is hard-coded. | "Relevance for {project.name} ({chip})". |

### 4.8 Papers `/research/papers` and paper detail [WS4; diagrams WS2]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| P-1 | P0 | `report/research-papers@390.json`, `report/research-claim-168@1440.json` | `ResultTiles` truncates the **value** (`div.truncate.font-semibold`, for example "32.2–79.1%") and its label. | `StatTile`: the value wraps and never truncates; the label clamps to 2 lines. The full context goes in a `Tooltip`. *(`ResultTiles` lives in `Explainers.tsx`, which is WS1's file: WS1 swaps it to `StatTile`.)* |
| P-2 | P1 | `crops/research-papers-top@1440.png` | **Discover** and **Distill pending** start jobs with no confirmation, and they sit next to the filters. Topics' "Refresh" *does* confirm. | Put them in a "Run ▾" menu: "Find new papers…" and "Summarise pending papers (30)…". Each opens a confirm dialog that says what it costs ("Runs on the worker, takes several minutes"). |
| P-3 | P2 | `crops/research-papers-top@1440.png` | The signals row shows "cites — · HF ↑ — · no code" as placeholders. "TL;DR" is a 10.5 px purple badge. Result values are purple. | Hide missing signals. "HF ↑" becomes a Hugging Face icon with the accessible label "Hugging Face upvotes". "TL;DR" → "In short:" in `fg` weight 600. Key results use the reference register (neutral ink). |
| P-4 | P2 | `crops/research-papers-top@1440.png` | The list doesn't show whether anything from the paper has been tested. | Add a line: "3 of 8 claims testable here · 1 tested (Partly reproduced)". |
| P-5 | P1 | `research-paper-2606.24033@1440.png` | The claim list on the paper page renders a **full flow diagram per claim**. | Use compact claim rows (title, headline, "Paper reports"), and put the diagram behind "Explain ▸". Use WS1's exported `ClaimSummary` when it's available; until then, hide `ClaimDiagram` in the list. |
| P-6 | P1 | `states/paper-conceptmap@1440.png` | **Regenerate** (a ~20 s LLM job that overwrites the map) is a plain link in the card header. | Put it in the card's "⋯" menu, with a confirm: "Map the concepts again? Replaces the current map (about 20 s)." |
| P-7 | P0 | `svg/_research_papers_arxiv_2606_24033_RoPE_Q_compute@390.png` | The paper's flow diagram sits inside a `min-w-[420px]` wrapper, inside `overflow-x-auto`. At 390 px, edge labels overlap the nodes and the rightmost node is cut off with no scroll cue. | WS2 (OV-13). Remove the `min-w-[420px]` wrapper and let `FlowDiagram` pick its orientation. |

### 4.9 Claims `/research/claims` and claim detail `/research/claims/:id` [WS1]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| C-1 | P0 | `research-claims@1440.png` (24,321 px), `@390` (44,842 px) | The same mega-card pattern as Recommendations (R-1). | Same compact card (shared `ClaimSummary` component). |
| C-2 | P1 | `crops/research-claim-168-top@1440.png` | The claim page never answers *"Has this been tested here, and did it hold?"*. The Experiments card in the sidebar shows "Experiment #9 · Building", with no verdict, no Δ and no title. | Add a status line under the title: "**Tested in #9** · Building" or "**Not tested yet** · Add to Gate 1 →". When there's a verdict, show the measured `AnswerBlock` next to the paper's claim. The sidebar list shows the outcome and Δ for each experiment. |
| C-3 | P1 | `states/tooltip-claim168-*.png` | Glossary meanings use two mechanisms: `<abbr title>` (invisible on touch and keyboard) and the absolutely positioned `TermChip`. | Use only `Term` / `InfoPopover` (WS0). |
| C-4 | P2 | `crops/research-claim-168-top@1440.png` | Raw LaTeX in the title and text ("4^{-b}"). | `MathText`: 4⁻ᵇ. |

### 4.10 Projects `/projects` [WS5]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| PR-1 | P1 | `crops/projects-top@1440.png` | **Re-profile** runs immediately, while **Re-match** asks for confirmation; they sit side by side. Neither label explains itself. | Put both in an "Actions ▾" menu, each with a confirm. "Re-profile" → "Reload lab.yaml". "Re-match" → "Re-rank claims for this project". |
| PR-2 | P2 | `crops/projects-top@1440.png` | Hardware is shown as raw key:value chips ("cuda: no", "memory gb: 64", "peak bandwidth gbs: 307"). | A definition list with human labels: "Memory 64 GB · Peak bandwidth 307 GB/s · CUDA no". |
| PR-3 | P2 | `crops/projects-top@1440.png` | Roofline: the gauge labels are 10.5 px, the cost-curve y-axis has no unit, and "mixed" isn't explained. | Use a plain sentence as the answer: "**Decoding runs at 58 % of the memory-bandwidth limit.** It's partly held back by overhead, so ideas that cut per-step overhead can still help." Axes get units (ms). Tile labels are 12 px. |

### 4.11 System `/system` [WS5]

| ID | Sev | Screenshot | Problem | Fix (and copy) |
|---|---|---|---|---|
| S-1 | P2 | `crops/system-top@1440.png` | There's no summary line, and the failed job (#15) is just a row like any other. | Add an answer line: "All services OK · 2 jobs running · **1 failed** (job #15, experiment #7) →". |
| S-2 | P2 | `crops/system-top@1440.png` | "Generate missing explanations" starts LLM work with no confirmation and no count. | "Write missing explanations (N)…", with a confirm dialog that states the expected time. |
| S-3 | P2 | `system@390.png` | The jobs table scrolls sideways on mobile. | Cards below 768 px (§3.8). |

### 4.12 Shared components

| ID | Component (owner) | Sev | Problem | Fix |
|---|---|---|---|---|
| SC-1 | `Badges.VerdictBadge` (WS0) | P0 | It wraps (OV-19), it's ALL CAPS at 10.5 px, and white on amber is 3.14:1. | `OutcomeBadge` (§3.6). |
| SC-2 | `Badges.Delta` (WS0) | P1 | A non-significant result is shown by fading to 60 % opacity, with colour only. | Use a word plus an icon ("no clear change"), and show the CI in a `Tooltip`. |
| SC-3 | `Badges.EffortChip` (WS0) | P1 | High effort is shown in `danger` red. | A neutral tag: "Effort: high". |
| SC-4 | `Badges.ModeBadge`, `DocTypeChip` (WS0) | P2 | Purple. | Neutral `Tag` with an icon. |
| SC-5 | `Explainers.TermChip`, `GlossaryText` (WS1) | P0 | OV-01…04. | Migrate to `Term` / `InfoPopover`. |
| SC-6 | `Explainers.ResultTiles`, `Tile`, `EffectTile`, `HardwareTile` (WS1) | P0/P2 | Truncated values (P-1), 10.5 px labels, and `truncate max-w-[150px]` on hardware names. | Use `StatTile`, which wraps. |
| SC-7 | `Explainers.LevelDots`, `BarMeterInline`, `GainGauge` (WS1) | P2 | 11 px labels, a 9 px "+", and colour-only meaning. | Use words with neutral dots, at 12 px. |
| SC-8 | `ClaimStory.HeroResult` (WS1) | P1 | The paper's number is green, with an up-arrow badge, as if it were a measured result. | Reference register (§3.3). |
| SC-9 | `Prediction.*` (WS1) | P1 | The reasons live in a multi-line native `title`, and "0…+10 %" is the range format. | `InfoPopover`, plus `formatRange` ("0 to +10 %"). |
| SC-10 | `Related.ConceptRef` (WS1) | P2 | Names are truncated at 24–36 characters, with the full name only in `title`. | Keep the truncation, add a `Tooltip`. |
| SC-11 | `FlowDiagram` (WS2) | P0 | Label collisions (OV-08…14). Label width is estimated at 6.3 px per character. `minScale 0.7` makes 9.5 px badges render at about 6.6 px. | See WS2. |
| SC-12 | `ConceptMap` (WS2) | P0/P1 | OV-16…18. Copy is hover-only ("Hover or focus a concept…"). | See WS2. Copy: "Select a concept to see what it needs and unlocks." |
| SC-13 | `Charts.ImprovementChart` (WS2) | P0 | OV-05…07. | See WS2. |
| SC-14 | `Stepper` (WS3) | P1 | It becomes vertical on mobile (X-7), and the state labels are 11 px. | Compact variant, 12 px labels. |
| SC-15 | `EventTimeline` (WS3) | P2 | Raw text. | A summary line and per-item "details". |
| SC-16 | `Insights` (WS4) | P2 | 10.5 px truncated KPI labels, and 11 px chips with tiny progress underlines. | `StatTile` and `Tag`. |
| SC-17 | `Roofline` (WS5) | P2 | PR-3. | — |
| SC-18 | `ui.Tabs` (WS0) | P2 | No arrow keys and no `aria-controls`. | §3.11. |
| SC-19 | `ui.PageHeader` (WS0) | P1 | There's no slot for the answer, and it can't promote an object title to h1. | Add `answer` and `breadcrumb` props. |

---

## 5. Overlap / clipping inventory

Every instance found, with selector, route and viewport. "Evidence" paths are relative to `web/dev/screenshots/ux-audit/`. The owner is the workstream that fixes it.

| ID | Sev | What overlaps or clips | Selector (component) | Route(s) | Viewport(s) | Evidence | Owner |
|---|---|---|---|---|---|---|---|
| OV-01 | P0 | The glossary tooltip renders **under the sticky header**: header `z-30` vs tooltip `z-20`. | `span.group.relative > span[role=tooltip]` (Explainers `TermChip`) vs `header.sticky.top-0.z-30` (Layout) | `/recommendations`, `/research/claims`, `/research/claims/168`, `/experiments/:id` (claim panel) | all 5 | `states/tooltip-rec-primer-Verification_budget_D@1440.png`, `states/tooltip-rec-primer-NFE@390.png` | WS0 + WS1 |
| OV-02 | P0 | The tooltip goes **above the viewport top** (y = −16 px) when the term is in the top ~80 px. There's no flip. | same | same | all 5 | `states/tooltip-claim168-RoPE_block@1440.png`; `states/_states.json` | WS0 + WS1 |
| OV-03 | P0 | The tooltip **overflows the right edge** (right = 410–500 px at 390): `left-0`, `w-64`, no shift. | same | `/research/claims/168` (RoPE block, Logical bit rate), `/recommendations` (NFE) | 390 | `states/tooltip-mid-claim168-Logical_bit_rate@390.png` | WS0 + WS1 |
| OV-04 | P1 | Explanations are carried **only** by the native `title`: never shown on touch or keyboard, and multi-line text is truncated by the OS. | `abbr[title]` (GlossaryText), `PredictionChip`/`PredictionRow`/`PredictedLine` `[title]`, `VerdictBadge[title]`, `BlockerBadge[title]`, `ConceptRef[title]`, `LevelDots[title]`, score formula `span[title]` | all claim and experiment routes | all | code + `states/rec-card1@1440.png` | WS0 primitive, WS1/WS3 migrate |
| OV-05 | P0 | Chart marker label "success bar +5%" sits flush on the band label "predicted here 0…+10%", and the **dashed marker line strikes through** the band label. | `svg[aria-label^="Measured improvement"] text` (Charts `ImprovementChart`) | `/experiments/6` (also 5 and 4 when a prediction band is present) | 1024–1440 | `crops/exp6-top@1440.png` | WS2 |
| OV-06 | P1 | Chart labels "target +29%" and "paper claims +41%" sit about 1 px apart, with marker lines between them. | same | `/experiments/1` | 1440 | `svg/improvement-chart-exp1@1440.png` | WS2 |
| OV-07 | P0 | The chart's text renders at **5.6 px** (390) and 12.4 px (768): the 560-unit viewBox is scaled to the container. | same | `/experiments/*` with a verdict | 390 (768 borderline) | `svg/improvement-chart-exp6@390.png` | WS2 |
| OV-08 | P0 | Edge label "runtime keys" is drawn **over** the node label "Allocate block bits" (vertical lane). | `figure svg text` (FlowDiagram `FlowComparisonDiagram` → `DiagramBody` edge labels) | `/experiments/9` (claim panel), `/recommendations`, `/research/claims/168` | 1024–1440 (narrow column → vertical), 390 | `svg/_experiments_9_Allocate_block@1280.png` | WS2 |
| OV-09 | P1 | The "changed" status badge collides with the edge label "runtime keys". | badge `g > rect + text` at `node.y − 8` | `/experiments/9` | 1024 | `svg/_experiments_9_changed@1024.png` | WS2 |
| OV-10 | P0 | Edge label "Window and outliers" overlaps the node label "Persistent chunk buffer". Loop labels "Store for reuse" and "Cache misses" cross the arrows. | FlowDiagram edge `text` | `/recommendations` (MemOnce claim) | 1024, 1280, 1440 | `svg/_recommendations_Persistent@1024.png`; background of `states/rec-start-dialog@1440.png` | WS2 |
| OV-11 | P0 | **Two parallel edge labels at the same coordinates:** "Two small blocks" is hidden under "One large block" (44×21 px). One label is invisible. | FlowDiagram edge `text` (labels of multi-edges between the same layers) | `/recommendations` ("Selectable block sizes" claim) | 1024–1440 | `svg/_recommendations_Two_small@1440.png` | WS2 |
| OV-12 | P0 | Vertical lane at 390: the edge labels "Original entries" and "Restore entries" sit over the node boxes; "Reconstruct missing chunks" collides with "Reuse hits"; "Select relevant entries" collides with "Local tokens". | FlowDiagram (vertical) | `/recommendations`, `/research/claims` | 390 | `svg/_recommendations_Generate@390.png`, `svg/_recommendations_Reconstruct@390.png`, `svg/_recommendations_Select_relevant@390.png` | WS2 |
| OV-13 | P0 | The paper's flow diagram at 390: "load codes" and "block rates" over "RoPE Q compute", "Index addr gen" vs "read vec", and the **rightmost node cut off**. The forced `min-w-[420px]` leaves no scroll cue. | `PaperDetail` `div.min-w-[420px] > figure svg` | `/research/papers/arxiv:2606.24033`, `/research/papers/arxiv:2611.27561` | 390 | `svg/_research_papers_arxiv_2606_24033_RoPE_Q_compute@390.png`, `svg/_research_papers_arxiv_2611_27561_Index_addr@390.png` | WS2 + WS4 |
| OV-14 | P1 | Node labels are truncated with "…" ("Operand-specif…"): wrapping is estimated at 6.3 px per character, with 3 lines max. | FlowDiagram `Node` `text > tspan` | `/recommendations` | 1440 | `svg/_recommendations_Two_small@1440.png` | WS2 |
| OV-15 | P2 | The lane switcher truncates "With Speculative verification wi…". | `figure > div[role=group] > button.truncate` | `/recommendations`, `/experiments/:id` claim panel | 390, and narrow columns at 1024–1440 | `crops/exp6-top@1440.png` (right column) | WS2 |
| OV-16 | P1 | A concept-map edge (3→7) passes **through** node 4's label. Node labels are truncated ("…bound fo…", "…at lo…"). | `#concept-map svg g[tabindex] text` (ConceptMap) | `/research/papers/arxiv:2606.24033`, `/research/claims/168` | 1024–1440 | `states/paper-conceptmap-hover@1440.png` | WS2 |
| OV-17 | P0 | At 390 the concept map is scaled to about 4 px text **and** clipped at the right edge. | `#concept-map div.overflow-x-auto > svg` | same | 390 | `states/paper-conceptmap@390.png` | WS2 |
| OV-18 | P1 | Hovering a node grows the FocusInfo panel, which pushes the legend and combined results **+39 to +223 px**: layout shift under the pointer. | ConceptMap `FocusInfo` (`div.min-h-16[aria-live]`) | same | all | `states/paper-conceptmap@1440.png` vs `states/paper-conceptmap-hover@1440.png`; `states/_states.json` | WS2 |
| OV-19 | P0 | The verdict pill wraps onto 2 lines ("NOT / REPRODUCED"). | `td > span.rounded-full.uppercase` (Badges `VerdictBadge`) | `/experiments` | 1024–1440 | `crops/experiments-top@1440.png` | WS0 |
| OV-20 | P0 | The table is clipped. Status is cut off; Stage, Verdict, Δ and Updated are off-screen with no cue. | `div.card > div.overflow-x-auto > table` (Experiments) | `/experiments` | 390 (768 partial) | `crops/experiments-top@390.png` | WS3 |
| OV-21 | P0 | **Page-level horizontal scroll** (`scrollWidth` 548 / 408 px). `th > span.sr-only` escapes its `overflow-x-auto` wrapper because there's no positioned ancestor. | `div.overflow-x-auto > table > thead th > span.sr-only` (VerdictV2 `TuningTable`) | `/experiments/4`, `/experiments/3` | 390 | `experiment-4-tuning@390.png`, `report/experiment-4-tuning@390.json` | WS0 (`TableScroll`) + WS3 |
| OV-22 | P0 | The fixed pick bar is **225 px tall** (27 % of the viewport) and permanently hides the last 41 px of the list. | `div.fixed.inset-x-0.bottom-0.z-20` (Recommendations) | `/recommendations` with ≥ 1 selection | 390 | `states/rec-pickbar-bottom@390.png` | WS0 (`StickyActionBar`) + WS1 |
| OV-23 | P0 | The toast stack covers the pick bar's buttons: 178×28 px over "Start 2 experiments" and 61×28 px over "Clear" (1440); it covers the bar at 390. | `div.fixed.right-4.bottom-4.z-50` (Toast) vs pick bar | `/recommendations` | all | `states/rec-pickbar-toast-sim@1440.png`, `states/rec-pickbar-toast-sim@390.png` | WS0 |
| OV-24 | P1 | Anchor targets land under the sticky header: `#gate` top = 0 while the header's bottom = 59. | `a[href="#gate"]`, `#concept-map`, `PaperDetail` `scrollIntoView` | `/experiments/:id`, `/research/papers/:id` | all | `svg/anchor-gate-under-header@1440.png` | WS0 |
| OV-25 | P0 | The result-tile **value** is truncated ("32.2–79.1%"), and so is its label. | `li > div.truncate.font-semibold.text-done` (Explainers `ResultTiles`) | `/research/papers`, `/research/papers/:id`, `/research/claims/168` | 390; narrow columns at 1024–1440 | `report/research-papers@390.json`, `report/research-claim-168@1440.json` | WS1 |
| OV-26 | P2 | Inline metric `code` chips break mid-token, so their boxes overlap across lines. | `dd > code.code-inline` (SpecGate `SpecDetails` via `DefinitionList`) | `/experiments/1,4,5,6,7,8,9` | 390 | `experiment-6-partial@390.png`, `report/experiment-6-partial@390.json` (`boxOverlaps`) | WS3 |
| OV-27 | P1 | Main-nav items Research, Projects and System, and the Experiments counter, are clipped off-screen. | `nav[aria-label=Main]` (Layout) | all | 390 (< 640) | `states/rec-fold@390.png` | WS0 |
| OV-28 | P2 | KPI labels are truncated ("HF UPVOTES"). | `dl > div > dt.truncate` (Insights `KpiRow`) | `/research/topics` | 390, 768 | `report/research-topics@390.json` | WS4 |
| OV-29 | P2 | List titles and paper lines are truncated to 1 line with no way to read them in full. | `div.truncate.font-medium`, `div.truncate.text-xs` (Overview) | `/` | 1024 (46 truncations), 390 | `report/overview@1024.json` | WS5 |

**Checked with no overlap found** (pass), at all 5 widths: `/research/topics/decoding`, `/research/claims/544`, `/projects` (apart from PR-2/PR-3 polish), `/system`, and the 404 page; plus the opened dialogs: Start experiments, Run research scan, Merge, Re-run and Measure roofline.

---

## 6. Implementation split

Six workstreams. **WS0 goes first.** WS1–WS5 branch from WS0 once it merges, and then run in parallel with minimal conflicts.

**Contract between workstreams:**

- Each file is owned by exactly one workstream.
- Cross-workstream use goes **only** through exported components and functions.
- Owners keep existing exports **backward compatible**: add new exports and props, don't rename or remove existing ones.
- `web/src/api/*.ts` and `components/LiveEvents.tsx` are unowned (no planned changes). The single exception: WS3 may *append* optional fields to `ExperimentSummary` in `api/types.ts`.

**Shared rules for every workstream:**

- Develop against the live gateway **read-only**: `cd web && PAPERATLAS_WEB_PORT=<unique port> npm run dev` proxies `/api` to `:8100`.
- Never click or POST pick, approve, revise, reject, merge, drop, rerun, cancel, retry, measure, generate, scan or regenerate.
- Playwright checks must abort non-GET requests (`context.route('**/*', r => r.request().method() === 'GET' ? r.continue() : r.abort())`).
- Every PR runs `npm run typecheck && npm test && npm run build`, plus `npm run ux:check -- --routes <owned routes>` (from WS0) at 390, 768, 1024, 1280 and 1440. Before and after screenshots go in `web/dev/screenshots/<ws>/` (gitignored).

### WS0: Foundation (shared primitives, tokens, shell)

**Owns:**

- `web/package.json`, `web/package-lock.json`
- `web/src/index.css`, `web/src/main.tsx`, `web/src/App.tsx`
- `web/src/components/ui.tsx`, `Badges.tsx`, `Icons.tsx`, `Dialog.tsx`, `Toast.tsx`, `Layout.tsx`
- **new** `web/src/components/Tooltip.tsx` (`Tooltip`, `InfoPopover`, `Term`)
- **new** `web/src/components/ActionBar.tsx` (`StickyActionBar`)
- **new** `web/src/components/Table.tsx` (`TableScroll`, `ResponsiveList` helpers)
- `web/src/lib/stages.ts` (+test), `web/src/lib/format.ts` (+test), `web/src/lib/roofline.ts` (+test)
- **new** `web/src/lib/semantics.ts` (+test)
- `web/src/pages/NotFound.tsx`
- **new** `web/dev/ux-check.mjs`

**Fixes:**

- **Dependencies and harness:** add `@floating-ui/react`, plus `playwright` as a devDependency with the script `"ux:check": "node dev/ux-check.mjs"`. Port [Appendix A](#appendix-a-how-overlaps-were-detected) into it. It's GET-only, takes a route list and viewports, writes screenshots and JSON, and exits non-zero on any assertion failure.
- **Tokens:** spacing, type scale, semantic colours, z-index scale, `--header-h`, `--action-bar-h`, and `scroll-padding-top` (§3.1–3.3, §3.11). Remove `text-subtle` from readable text in the files WS0 owns, and document the rule for the others.
- **`lib/semantics.ts`:** the canonical label, tone, icon and description for status, claim check, adoption, likelihood, diagnosis, fidelity, bottleneck and gain (§3.3, Appendix B). `stages.ts` `STATUS_INFO`/`VERDICT_INFO` and `roofline.ts` `LIKELIHOOD_INFO`/`BOTTLENECK_INFO` re-export from it.
- **Tooltip primitives** (§3.5), portal-rendered.
- **Badges:** `StatusChip` (nowrap), `OutcomeBadge` (replaces `VerdictBadge`; keep `VerdictBadge` as a wrapper for compatibility), `Delta` (significance in words), `Tag` (neutral; `CategoryChip`, `ModeBadge`, `DocTypeChip` and `EffortChip` restyled onto it), `CodeToken`.
- **`ui.tsx`:**
  - `PageHeader` gets `answer` and `breadcrumb` props, and an h1 for the object title.
  - `CardHeader`, `AnswerBlock` (measured, predicted or claimed register), `Disclosure`, `ChipRow` (max 3 plus "+N"), `StatTile`.
  - `Tabs` gets roving focus and arrow keys.
  - `Skeleton` variants, and `ErrorState` with a "Technical details" disclosure.
- **`format.ts`:** `formatRange(low, high, unit)` gives "0 to +10 %"; `formatSigned`; a `formatNumber` precision policy; `MathText` / `formatMath` turns `^{…}` and `_{…}` into sup and sub; `humanizeMetric('throughput_tokens_per_s')` gives "Throughput (tokens/s)"; `formatAcronyms`.
- **`Layout`:** the compact nav below 640 px, the persistent "Needs you" pill, `--header-h`, and the footer copy (G-1, G-2, G-5).
- **`Toast`:** offset above `--action-bar-h`; top-centre on mobile (G-3).
- **`Dialog`:** an `initialFocus` prop, defaulting to Cancel for danger (G-4).
- **`ActionBar`:** one line; publishes `--action-bar-h`; adds page padding.
- **`TableScroll`:** `relative overflow-x-auto`, edge shadows, sticky first column option (§3.8).

**Acceptance criteria:**

- `Tooltip` and `InfoPopover` are fully inside the viewport, and below `--header-h`, for a trigger at (x = 8, y = header + 4), at (x = innerWidth − 8), and inside a clipping `overflow-hidden` container. Verify on a dev-only route `/__ux` that renders all primitives, at 390, 768 and 1440. They open on hover, focus, tap and Enter; Esc closes them and focus returns to the trigger.
- `OutcomeBadge` never wraps, and every badge/chip text-to-background contrast is ≥ 4.5:1 (axe or a computed check).
- No `text-[…]` below 12 px remains in the files WS0 owns, and `ux:check` reports the offenders in other files as warnings.
- The `/__ux` table route containing a `<th><span class="sr-only">` has no document horizontal scroll at 390.
- A toast never intersects `StickyActionBar` (checked on `/__ux`).
- The nav exposes all 6 destinations and the needs-you count at 390.
- `npm run typecheck && npm test && npm run build` pass. Existing pages render with no new overlaps (`ux:check` on all routes stays at or below the baseline in §5).

**Verification:** `npm run ux:check -- --routes /,/experiments,/__ux --vps 390,768,1024,1280,1440`. Review the screenshots of `/__ux` (tooltip edge cases, badges, stat tiles, action bar with toast). Tab through the header, tabs and a dialog using only the keyboard.

### WS1: Claim surfaces (Gate 1, claim cards, claim pages)

**Owns:**

- `web/src/pages/Recommendations.tsx`, `web/src/pages/research/Claims.tsx`, `web/src/pages/research/ClaimDetail.tsx`
- `web/src/components/ClaimStory.tsx`, `Explainers.tsx`, `Prediction.tsx`, `Related.tsx`, `ClaimCard.tsx`
- `web/src/lib/claims.ts` (+test), `web/src/lib/explainer.ts` (+test)

**Fixes:**

- R-1…R-10, C-1…C-4, SC-5…SC-10, OV-01…04 (migration), OV-22 (adopt `StickyActionBar`), OV-25.
- Create and export **`ClaimSummary`**, the compact card (§3.4), for use by Recommendations, Claims, and later PaperDetail (WS4) and ExperimentDetail (WS3).
- Answer register: predicted first, paper second in the reference register.
- `GlossaryText` and `TermChip` migrate to `Term`.
- `ResultTiles`, `Tile` and `KeyNumbers` migrate to `StatTile`.
- Prediction reasons move to an `InfoPopover`.
- Filters collapse on mobile.
- The status line on claim detail (C-2).

**Acceptance criteria:**

- `/recommendations`: collapsed card height ≤ 200 px at 1440 and ≤ 280 px at 390 for 90 % of cards. Total page height ≤ 7,000 px at 1440 with 30 cards.
- The first card's answer (expected gain here) is visible above the fold at 390 (y < 600) with filters collapsed.
- Zero tooltip findings on owned routes (`ux:check` tooltip probe at the top edge, the right edge and mid-page).
- No native `title` is the only carrier of a meaning or reason.
- The pick bar is ≤ 64 px tall at every width. With a selection, no content is hidden at full scroll. A toast never covers the bar.
- `/research/claims/168` shows the "Tested in #9 · Building" line under the title.
- `/research/claims` collapsed rows match `/recommendations`.

**Verification:** `npm run ux:check -- --routes /recommendations,/research/claims,/research/claims/168,/research/claims/544`. Manual checks (all client-side, no POST):

- Select two claims and confirm that the bar, then the Start dialog, open. Cancel.
- Use Explain, Evidence and "Why this estimate?" with the keyboard and by tap (Playwright `hasTouch`).
- Compare before and after screenshots of card 1.

### WS2: Diagrams and charts

**Owns:**

- `web/src/components/FlowDiagram.tsx`, `ConceptMap.tsx`, `Charts.tsx`
- `web/src/lib/flow.ts` (+test), `web/src/lib/conceptMap.ts` (+test)

**Fixes:**

- OV-05…18, SC-11…13, P-7 (diagram side).
- **Flow layout (`lib/flow.ts`):**
  - Measure label widths. Use `canvas.measureText` with the actual font in a small `measureLabel()` util with a cache, instead of 6.3 or 6.9 px per character.
  - Reserve an **edge-label lane** between layers sized to the widest label. Place labels at the edge midpoint with collision avoidance against node rects, badges and other labels. Unit tests assert no rect intersections for the fixture diagrams.
  - Multi-edges between the same pair: stagger the labels or merge them ("16 or 32 blocks").
  - Status badges sit inside the node's top-right corner, never on the edge path.
- **Rendered-size rule:**
  - Compute the scale and switch to vertical, or to one-lane-at-a-time with the existing lane switcher, before any text renders below 11 px.
  - Remove `minScale 0.7` shrinkage.
  - Node labels wrap to up to 3 lines, with no ellipsis in full mode. When truncation is unavoidable, the full label goes in a `Tooltip` from WS0.
- **`ConceptMap`:**
  - The FocusInfo panel has a **fixed height with internal scroll**, or becomes an `InfoPopover` anchored to the node. No layout shift.
  - Edges route around node boxes: orthogonal or bundled routing with a node-avoidance check, or put labels in the row gap.
  - Below 640 px, render a **list view** (reading order, role, "needs / unlocks") with "Show map" for the SVG at native size in a scroll box with a "Scroll →" hint.
  - Tap or Enter selects; copy per SC-12.
- **`ImprovementChart`:**
  - Labels use a collision-aware row allocator over every label: markers, the band label, "measured" and "0%". Marker lines stop above their label rows and never cross text.
  - Font sizes are set from the rendered width (≥ 12 px at all widths). Below 480 px, use a taller layout with labels in a legend list under the axis.
  - Range copy: "Expected here: 0 to +10 %".
- **Legends:** 12 px; swatches plus words.

**Acceptance criteria:**

- `ux:check` reports 0 `svgTextOverlaps` and 0 `svgTextOutside` on every route, at every width.
- The minimum rendered SVG font size is ≥ 11 px (diagrams) and ≥ 12 px (chart). `ux:check` computes this as `fontSize × CTM scale`.
- Concept-map hover and focus cause 0 px layout shift (measured as card height before/after).
- The concept map at 390 is readable through the list view.
- The flow fixtures in `lib/flow.test.ts` assert no label/node/badge intersections, including the multi-edge "Two small blocks / One large block" case and the "runtime keys / Allocate block bits" case.
- Exported props of `FlowDiagram`, `FlowComparisonDiagram`, `ConceptMapGraph`, `ConceptMapCard` and `ImprovementChart` are unchanged; new ones are optional.

**Verification:** `npm test` (layout unit tests), then `npm run ux:check -- --routes /recommendations,/experiments/6,/experiments/1,/experiments/9,/research/papers/arxiv:2606.24033,/research/papers/arxiv:2611.27561,/research/claims/168`. Compare close-ups of every diagram in §5 (OV-05…18) before and after, at 390, 1024 and 1440.

### WS3: Experiments and Gates 2 and 3

**Owns:**

- `web/src/pages/Experiments.tsx`, `web/src/pages/ExperimentDetail.tsx`
- `web/src/pages/experiment/Protocol.tsx`, `SpecGate.tsx`, `VerdictPanel.tsx`, `VerdictV2.tsx`, `Sections.tsx`
- `web/src/components/Stepper.tsx`, `EventTimeline.tsx`
- `web/src/lib/protocol.ts` (+test), `web/src/lib/spec.ts` (+test)
- append-only optional fields in `web/src/api/types.ts`

**Fixes:**

- E-1…E-5, X-1…X-14, OV-20, OV-21 (adopt `TableScroll`), OV-26.
- **Decision summary**, with the recommendation logic in `lib/protocol.ts` as `recommendDecision(verdictDetail)`, unit-tested over every adoption/claim/quality combination.
- The recommended action becomes the primary button. The Merge dialog recaps the evidence and warns when the recommendation is Drop.
- Neutral verdict tiles.
- Evidence and run details move into disclosures. The diagnosis is clamped.
- Compact header and stepper on mobile.
- The experiments list becomes cards below 768 px.
- An "Outcome" column, with the adoption line behind the optional `adoption_verdict` field.
- Gate 2 restructure: test plan at a glance → decision → "Edit plan".
- Plain failed state.
- `EventTimeline` gets a summary line and per-item details (this also improves Overview O-5).
- `ADOPTION_INFO`/`DIAGNOSIS_INFO`/`FIDELITY_INFO` re-export from `lib/semantics.ts`.

**Acceptance criteria:**

- On `/experiments/6` (claim *partial*, adoption *regression*), the first 600 px at 390 and the first screen at 1440 show "Recommendation: Drop", both outcomes, and the decision buttons. **Drop** is the primary button.
- `/experiments/5` (claim *reproduced* +5.4 %, adoption *no measurable gain* +0.5 %) shows **"Your call"**, with no primary styling on either action and the reason stated.
- `/experiments/3` (adoption *regression* −21.5 %) shows Drop as primary.
- The Merge dialog shows the recap.
- No document horizontal scroll on any `/experiments/*` at 390.
- `/experiments` at 390 shows the status, outcome and CTA of every row with no horizontal scrolling.
- No `NOT / REPRODUCED` wrap at any width.
- Gate 2 renders the test plan at a glance before the form. Verify it with a Playwright fixture: `page.route('**/api/lab/experiments/6', r => r.fulfill({ json: { ...real, status: 'awaiting_approval', gate: 'approve_spec' } }))`. This is a GET-only stub; **never** call the decision endpoints.
- `recommendDecision` unit tests pass.

**Verification:** `npm test`, then `npm run ux:check -- --routes /experiments,/experiments/1,/experiments/3,/experiments/4,/experiments/5,/experiments/6,/experiments/7,/experiments/8,/experiments/9`. Open the Merge, Drop and Re-run dialogs and cancel them. Check that "See the recommendation ↓" lands below the header.

### WS4: Research (topics and papers)

**Owns:**

- `web/src/pages/research/ResearchLayout.tsx`, `Topics.tsx`, `TopicDetail.tsx`, `Papers.tsx`, `PaperDetail.tsx`
- `web/src/components/Insights.tsx`

**Fixes:**

- RL-1, T-1…T-4, P-2…P-6, OV-13 (remove the `min-w-[420px]` wrapper), OV-28.
- Detail pages promote the object title to h1, with a breadcrumb.
- Topic display names.
- `KpiRow`, `SparkBars` and `CategoryCounts` move onto `StatTile` and `Tag`.
- Job buttons move into "Run ▾" with confirms. Regenerate moves into an overflow menu with a confirm.
- Paper rows show the tested status.
- The claim list on paper detail is compact: diagrams behind Explain, or WS1's `ClaimSummary` when it has merged.

**Acceptance criteria:**

- Detail routes have exactly one h1, and it's the object title.
- At 390, the paper detail page's TL;DR and key results show in the first 600 px.
- No truncated numeric value on owned routes.
- Every action that queues a job opens a confirm.
- `ux:check` is clean on owned routes, including the diagram overlaps once WS2 has merged. Before that, the WS4 side of OV-13 is just the removed wrapper.

**Verification:** `npm run ux:check -- --routes /research/topics,/research/topics/decoding,/research/papers,/research/papers/arxiv:2606.24033,/research/papers/arxiv:2611.27561`. Open the confirm dialogs and cancel them. Check the keyboard tab order on topic cards.

### WS5: Overview, Projects, System

**Owns:**

- `web/src/pages/Overview.tsx`, `Projects.tsx`, `System.tsx`
- `web/src/components/Roofline.tsx`, `JobStatus.tsx`

**Fixes:**

- O-1…O-7, PR-1…PR-3, S-1…S-3, OV-29.
- The answer line on Overview, with honest outcome tiles (all 5 outcomes).
- Unified gate rows with the recommendation chip. Until WS3 merges, use the claim/adoption outcome only.
- `StatTile` everywhere.
- The Projects action menu with confirms; human hardware labels; a plain-sentence roofline answer with units on the axes.
- The System answer line, a failed-job callout, and cards below 768 px.

**Acceptance criteria:**

- On `/` at 390 and at 1440, the first screen states how many decisions are waiting and lists them first.
- The Verdicts tile shows all outcome categories and their counts sum to the total.
- No 10.5 px text on owned routes.
- Every job-starting action on Projects and System opens a confirm.
- `ux:check` is clean on `/`, `/projects` and `/system`.

**Verification:** `npm run ux:check -- --routes /,/projects,/system`. Open the Re-match, Reload lab.yaml, Measure and Write explanations confirms and cancel them.

**After everything merges:** run `npm run ux:check` across all routes and all 5 widths. Pass means:

- 0 overlaps;
- 0 tooltip findings;
- no horizontal scroll;
- rendered SVG text ≥ 11 px;
- the [§1](#1-executive-summary-the-top-10-problems-ranked-by-impact) problems are closed.

---

## Appendix A: how overlaps were detected

The audit's detector ran in the page with `page.evaluate`. WS0 should port it into `web/dev/ux-check.mjs`. The essentials:

```js
// 1) Visible = el.checkVisibility({contentVisibilityAuto:true, opacityProperty:true, visibilityProperty:true})
//    and not inside a closed <details> (except its <summary>) and not .sr-only.
// 2) Text rects: for each non-empty text node, Range.getClientRects(), each CLIPPED to the
//    intersection of all ancestors whose overflow-x/y != visible (otherwise truncated / scrolled
//    text produces false positives). Bucket rects on a 64 px grid; report pairs from different
//    elements intersecting > 2×3 px, ignoring pairs where only one side is fixed/sticky.
// 3) Boxes: siblings with a border or background (not absolutely positioned) that intersect > 2×2 px.
//    Ignore inline elements that wrap across lines (their bounding box spans both lines).
// 4) Viewport: document.documentElement.scrollWidth > innerWidth → find the culprit by hiding children
//    one by one from <body> down until scrollWidth fits (this is how OV-21's sr-only span was found).
// 5) SVG: for every <text> in an <svg> ≥ 60 px wide, getBoundingClientRect() pairwise intersection
//    (> 2×2 px), and text outside the svg's rect. Rendered font = fontSize × svg.getScreenCTM().a.
// 6) Tooltips: hover/focus each trigger after scrolling it to (a) 70 px below the top, (b) the right
//    edge, (c) mid-screen; temporarily set pointer-events:auto on the floating element, then check
//    rect inside viewport, rect below --header-h, no clipping ancestor, and elementFromPoint() at 3 points
//    inside the tooltip returns the tooltip itself.
// 7) Truncation inventory: text-overflow:ellipsis or -webkit-line-clamp with scroll size > client size;
//    flag any truncated element whose text matches /[0-9]/ as a "truncated number" failure.
// 8) Targets < 24×24 and computed font-size < 12 px are counted and reported (warnings in phase 1).
// Safety: context.route('**/*') aborts every non-GET request.
```

## Appendix B: UI vocabulary

Use exactly these words. They're defined once in `lib/semantics.ts`, and copy elsewhere refers to them.

| Concept | Say | Don't say |
|---|---|---|
| The paper's number | "Paper reports X" | "claimed —", "THE PAPER REPORTS" (caps), green "up to" hero |
| Cost-model estimate | "Expected here: A to B" + likelihood ("Likely gain", "Small or no gain", "Unlikely to help", "Not estimated") | "Predicted here 0…+10 %", "marginal", "unknown" |
| A/B result vs the paper's setup | "Claim check" + "Reproduced / Partly reproduced / Not reproduced / Worse than baseline / Inconclusive" | "Partial", "Regression", "REPRODUCED" |
| A/B result on the project default | "Adoption check" + "Worth adopting / Small gain / No measurable gain / Worse than default / Inconclusive" | "No gain", "Regression" |
| Gate 1 / 2 / 3 | "Pick claims to test" / "Approve the test plan" / "Decide: merge or drop" | "Gate 2 · Review & approve the experiment spec" (OK as a subtitle only) |
| Δ not significant | "no clear change (95 % CI −0.4 to +1.2 %)" | a faded number |
| Ranges | "+5 to +30 %", "0 to +10 %" | "+5…+30%", "0…+10%" |
| Metric IDs | "Throughput (tokens/s)", with `throughput_tokens_per_s` on expand or hover | the bare ID in plain-language text |
| Jobs that cost time | "Find new papers…", "Summarise pending papers…", "Reload lab.yaml…", "Re-rank claims…", "Write missing explanations…" | "Discover", "Distill pending", "Re-profile", "Re-match" without a confirm |
