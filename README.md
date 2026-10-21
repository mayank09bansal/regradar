# RegRadar

RegRadar is a multi-agent regulatory change radar for compliance teams. It
turns regulatory documents into traceable, prioritised compliance gaps and a
remediation plan.

The repository contains a FastAPI backend, a React dashboard, a deterministic
demo mode, and an optional live LLM mode. The demo uses synthetic
RBI/MeitY-style regulations and a fictional company called Acme Pay. It is
intended for demonstration and education, not legal advice.

## What it does

RegRadar runs six cooperating agents:

1. **Regulatory Scout** finds relevant documents from the demo dataset, pasted
   text, or supported RSS sources.
2. **Obligation Extractor** identifies obligations, modal verbs, deadlines,
   frequencies, and retention periods.
3. **Control Mapper** compares obligations with the internal control library.
4. **Gap Synthesiser** proposes actionable compliance gaps.
5. **Novelty Validator** independently checks each proposal and feeds
   structured rejection feedback back to the synthesiser.
6. **Output Agent** creates the prioritised remediation plan and report.

The validator feedback loop is bounded and observable. Every agent message,
decision, revision, and error is recorded in the execution trace.

## Features

- Deterministic demo mode with no API keys required.
- Live mode for Anthropic and OpenAI-compatible providers.
- FastAPI JSON API with interactive OpenAPI documentation.
- React, TypeScript, and Vite dashboard.
- Nine rule-based validation checks for grounding, citations, novelty,
  duplicates, modality, severity, detail, and obligation existence.
- SQLite storage by default, with optional PostgreSQL persistence.
- Slack and n8n notification integrations.
- Vercel deployment support.
- Automated backend and frontend checks.

## Requirements

- Python 3.11 or newer
- Node.js 18 or newer and npm
- PowerShell on Windows (the commands below use PowerShell syntax)

## Quick start

### 1. Set up the backend

Run these commands from the repository root:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
python -m pip check
Copy-Item .env.example .env
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

The demo does not require any values in `.env`. If PowerShell blocks
`Activate.ps1`, run:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Alternatively, use `.\.venv\Scripts\python.exe` without activating the
environment.

### 2. Start the dashboard

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173> and select **Run deterministic demo**.

Useful URLs:

| URL | Purpose |
| --- | --- |
| <http://localhost:5173> | React dashboard |
| <http://127.0.0.1:8000/docs> | FastAPI Swagger UI |
| <http://127.0.0.1:8000/api/health> | API health check |

To run the demo without the dashboard:

```powershell
python -m backend.cli demo --report
```

## Testing and quality checks

Run the backend tests and linting from the repository root:

```powershell
python -m pytest
python -m ruff check backend tests
```

Run frontend checks:

```powershell
cd frontend
npm run lint
npm run typecheck
npm run build
```

Or run the Windows verification script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

## API overview

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Check API and database availability |
| GET | `/api/config` | Read public, non-secret configuration |
| GET | `/api/agents`, `/api/graph` | Inspect agents and graph structure |
| GET | `/api/sources/demo-dataset` | Inspect the synthetic source dataset |
| GET | `/api/controls` | Inspect the control library |
| POST | `/api/demo/run` | Run the deterministic demo |
| POST | `/api/runs` | Start an analysis run |
| GET | `/api/runs` | List saved runs |
| GET | `/api/runs/{id}` | Read a run |
| GET | `/api/runs/{id}/trace` | Read the agent execution trace |
| GET | `/api/runs/{id}/report` | Return a JSON or Markdown report |
| DELETE | `/api/runs/{id}` | Delete a run |
| POST | `/api/integrations/test` | Test configured webhooks |

## Live mode

The default demo is deterministic. To use a live model, configure the
provider, model, and matching credential in `.env`. See
[docs/environment-variables.md](docs/environment-variables.md) for the full
table and supported OpenAI-compatible endpoints.

Never commit `.env` or API keys. Live model output is treated as advisory;
the rule-based validator remains authoritative.

## Project structure

```text
backend/                 FastAPI app, agents, orchestration, storage, and integrations
data/                    Synthetic regulations and the control library
docs/                    Architecture, setup, deployment, and demo documentation
frontend/                React + TypeScript dashboard
n8n/                     Example scheduled notification workflow
scripts/                 Local verification scripts
tests/                   Backend and API tests
standalone_examples/     Isolated examples; not imported or used by the app
```

The `standalone_examples` folder is deliberately disconnected from the
application. It is safe to delete, ignore, or run independently and is not
included in the backend package, test suite, Docker image, or deployment
configuration.

## Documentation

- [Run guide](docs/run-guide.md) - setup, usage, and troubleshooting
- [Architecture](docs/architecture.md) - agents, state, graph, and feedback loop
- [Demo script](docs/demo-script.md) - suggested demonstration flow
- [Deploy on Vercel](docs/deploy-vercel.md) - production deployment
- [Environment variables](docs/environment-variables.md) - configuration reference
- [Evaluator Q&A](docs/evaluator-qa.md) - design questions and answers
- [References](docs/references.md) - supporting references
- [CA3 checklist](docs/ca3-compliance.md) - project compliance mapping

## Deployment

RegRadar can be deployed as one Vercel project. Import the repository with
the repository root as the project root. Vercel uses `vercel.json` to build
the dashboard and exposes `backend.main:app` as the Python entry point.

For persistent run history, configure a PostgreSQL `DATABASE_URL`. Without
it, local or serverless storage is temporary. See
[docs/deploy-vercel.md](docs/deploy-vercel.md) for the complete procedure.

## Limitations

RegRadar is a prototype. Control mapping is primarily lexical, the bundled
control library is small and fictional, RSS feeds may contain summaries
instead of full circulars, and the application has no authentication.
Results must be reviewed by a qualified compliance or legal professional.
