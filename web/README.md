# PaperAtlas web console

The browser UI for **Research → Experiment**: recommended claim cards (Gate 1), experiment spec review
(Gate 2), verdicts with merge/drop (Gate 3), live progress, and the research that feeds it all.

Stack: Vite + React + TypeScript + Tailwind CSS v4 + React Router + TanStack Query. It talks only to the
**gateway** (`/api/research/*`, `/api/lab/*`, `/api/services`) and uses Server-Sent Events for live updates.

| Screen | Route | Backend |
| --- | --- | --- |
| Overview — stats, *Needs you*, in-progress experiments, live activity, services | `/` | `research/stats`, `lab/experiments`, `lab/triage`, `lab/activity`, `lab/events/stream` |
| Recommendations — Gate 1, research scan with live progress | `/recommendations` | `lab/projects/{id}/recommendations`, `POST lab/experiments`, `POST lab/projects/{id}/triage`, `lab/triage/{id}/stream` |
| Experiments — Needs you / Active / All | `/experiments` | `lab/experiments?status=` |
| Experiment detail — stepper, Gate 2 form, Gate 3 verdict, timeline, log, build, runs | `/experiments/:id` | `lab/experiments/{id}` (+ `/spec`, `/spec/decision`, `/decision`, `/cancel`, `/retry`, `/stream`, `/log`, `/report`) |
| Research — topics, papers & patents, claim cards | `/research/*` | `research/topics`, `research/papers`, `research/claims`, … |
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

`web/dev/seed_demo.py` loads realistic fixtures (project `inference-lab`, 8 topics, 13 papers incl. a patent,
25 claim cards, matches with blockers, a research scan waiting at Gate 1, and experiments in every interesting
state — awaiting approval, building, running, awaiting decision with a judged verdict and HTML report, merged,
failed — plus their events, jobs and logs). It **wipes the `research` and `lab` schemas**, so it only runs
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
src/lib/        pure helpers + tests: formatting, stage/status mapping, spec override diffing
src/components/ layout, badges, stepper, timeline, dialogs, charts (hand-made SVG), claim card
src/pages/      one file per screen; experiment/ holds the Gate 2 and Gate 3 panels
```
