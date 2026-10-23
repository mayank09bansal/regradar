# Standalone regulatory report example

This folder is intentionally disconnected from RegRadar.

- It imports only Python standard-library modules.
- Nothing in `backend/`, `frontend/`, `tests/`, Docker, or deployment
  configuration imports or executes it.
- It does not change the application's database, API, graph, or UI.
- It can be deleted or run independently without changing RegRadar.

The example turns a small JSON list of regulatory changes into a Markdown
triage report. It is illustrative code, not a replacement for the actual
RegRadar pipeline.

## Run it

From the repository root:

```powershell
python standalone_examples\report_generator.py `
  --input standalone_examples\sample_changes.json `
  --output standalone_examples\sample_report.md
```

The generated report is ignored by version control. Use `--stdout` to print
the report instead of writing a file.
