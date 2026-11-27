# PaperAtlas web console

The browser UI for **Research → Experiment**: recommended claim cards (Gate 1), experiment spec review
(Gate 2), verdicts with merge/drop (Gate 3), live progress, and the research that feeds it all.

Stack: Vite + React + TypeScript + Tailwind CSS v4 + React Router + TanStack Query. It talks only to the
**gateway** (`/api/research/*`, `/api/lab/*`, `/api/services`) and uses Server-Sent Events for live updates.

| Screen | Route | Backend |
| --- | --- | --- |
| Overview — stats, *Needs you*, in-progress experiments, live activity, services | `/` | `research/stats`, `lab/experiments`, `lab/triage`, `lab/activity`, `lab/events/stream` |
| Recommendations — Gate 1 (single / bundle / chain when a claim has prerequisites), linked concepts on each card, “Predicted here” cost-model chip with filter/sort by likelihood, research scan with live progress | `/recommendations` | `lab/projects/{id}/recommendations`, `POST lab/experiments` (`mode`), `POST lab/projects/{id}/triage`, `lab/triage/{id}/stream` |
| Experiments — Needs you / Active / All (↻ marks re-runs); search (title, technique, paper, `#id`) and filters for status, claim check, adoption check, technique category and measured change, combined, counted per value, in the URL, one-click clear | `/experiments` | `lab/experiments/search?scope=&q=&status=&verdict=&adoption=&category=&change=&min_change=&change_of=&limit=&offset=` |
| Experiment detail — stepper (with tune stage and iteration), Gate 2 form + “How we’ll test the paper’s claim” protocol editor + “Predicted on this engine”, Gate 3 claim vs adoption verdicts (predicted range as a band), diagnosis, mechanism counters, tuning, iterations (kept / reverted), re-run (reuse spec or re-plan; re-run of / re-runs links), plan (bundle members, waits for / unlocks), timeline, log, build, runs | `/experiments/:id` | `lab/experiments/{id}` (+ `/spec`, `/spec/decision`, `/decision`, `/cancel`, `/retry`, `/rerun`, `/stream`, `/log`, `/report`) |
| Research — topics, papers & patents (concept map: reading order, prerequisites, combined results), claim cards (how each concept connects) | `/research/*` | `research/topics`, `research/papers` (+ `POST /{id}/concept-map`), `research/claims`, … |
| Projects — profiles from `lab.yaml`, engine roofline (bandwidth gauge, verification cost curve, batched decode, draft vs target; measure with job progress), register, re-profile, re-match (with job progress) | `/projects` | `lab/projects` (+ `POST`, `/{id}/profile`, `/{id}/match`, `/{id}/roofline`), `lab/jobs` |
| System — service health, job queue | `/system` | `api/services`, `lab/jobs` |

## Run

```bash
# backend (from the repo root): migrations + research-api, lab-api, gateway (add the worker to execute jobs)
.venv/bin/paperatlas services up --only research lab gateway

# development (hot reload on :5173, proxies /api to the gateway on $PAPERATLAS_GATEWAY_PORT, default 8100)
cd web && npm install && npm run dev

# production: the gateway serves web/dist (with SPA fallback) at http://127.0.0.1:8100
cd web && npm run build
```

Checks: `npm run typecheck`, `npm test` (vitest, pure helpers in `src/lib`), `npm run build`.

## Demo data

`web/dev/seed_demo.py` loads realistic fixtures (project `inference-lab` with a measured roofline, 8 topics, 13 papers incl. a patent,
29 claim cards with explainers (four with the v2 plain-language layer — primer, headline result, before/after
flow — and the rest v1, to exercise the fallback), concept maps with typed links and combined results, matches with blockers and cost-model predictions (likely / marginal / unlikely), a
research scan waiting at Gate 1, and experiments in every interesting state — awaiting approval, building,
running, awaiting decision with a judged verdict and HTML report, merged, failed, a chain (prerequisite awaiting
approval → dependent blocked), a blocked dependent whose prerequisite was not merged, a bundle, and three protocol v2
experiments (Gate 2 with a paper baseline/workload/knobs/counters, Gate 3 after two iterations, one tuning, one that kept
iteration 1 of 2), a re-run of the failed experiment waiting at Gate 2 — plus
their events, jobs and logs). It **wipes the `research` and `lab` schemas**, so it only runs
against a database whose name ends with `_ui` (or with `--force`):

```bash
createdb paperatlas_ui
export PAPERATLAS_DATABASE_URL=postgresql+psycopg://localhost/paperatlas_ui
export PAPERATLAS_DATA_DIR=data/ui-demo          # optional: keep demo reports/logs apart from real runs
.venv/bin/python web/dev/seed_demo.py
PAPERATLAS_GATEWAY_PORT=8200 PAPERATLAS_RESEARCH_PORT=8201 PAPERATLAS_LAB_PORT=8202 \
  .venv/bin/paperatlas services up --only research lab gateway
```

Without a worker, gate buttons simply queue jobs (visible on the System page); nothing is built or benchmarked.

## Layout

```
src/api/        typed client (client.ts), TS mirrors of the service dicts (types.ts),
                TanStack Query hooks (queries.ts), SSE hook with reconnect/resume (sse.ts)
src/lib/        pure helpers + tests: formatting, stage/status mapping, spec override diffing,
                flow-diagram layout (incl. before/after alignment and a top-to-bottom variant for narrow screens),
                explainer v2 helpers (hero result, theme), concept-map layout, protocol v2 form/diff helpers
src/components/ layout, badges, stepper, timeline, dialogs, charts (hand-made SVG), claim card;
                ClaimStory.tsx = shared claim blocks (hero result, primer, today vs. paper, flow, paper vs. here)
src/pages/      one file per screen; experiment/ holds the Gate 2 and Gate 3 panels
```
