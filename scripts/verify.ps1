# RegRadar end-to-end verification for Windows PowerShell.
# Run from the project root:   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
# Optional: -SkipFrontend  to check only the backend.
param([switch]$SkipFrontend)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$py = Join-Path $root ".venv\Scripts\python.exe"
$results = [ordered]@{}

function Step($name, [scriptblock]$block) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    try {
        & $block
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
        $results[$name] = "PASS"
    } catch {
        Write-Host "FAILED: $_" -ForegroundColor Red
        $results[$name] = "FAIL"
    }
}

if (!(Test-Path $py)) {
    Write-Host "Creating .venv ..." -ForegroundColor Yellow
    py -m venv .venv
}

Step "Python interpreter is the project .venv" { & $py -c "import sys; print(sys.executable); assert '.venv' in sys.executable" }
Step "Install backend dependencies" { & $py -m pip install --disable-pip-version-check -q -r requirements-dev.txt }
Step "pip check" { & $py -m pip check }
Step "Ruff lint" { & $py -m ruff check backend tests }
Step "Backend unit tests" { & $py -m pytest tests/test_text_and_parsing.py tests/test_agents.py tests/test_sources.py }
Step "Feedback-loop orchestration tests" { & $py -m pytest tests/test_feedback_loop.py -v }
Step "API tests" { & $py -m pytest tests/test_api.py }
Step "CLI demo run" { (& $py -m backend.cli demo) | Select-Object -First 8 }

if (-not $SkipFrontend) {
    Push-Location frontend
    try {
        if (Test-Path package-lock.json) { Step "npm ci" { npm ci } } else { Step "npm install (creates package-lock.json)" { npm install } }
        Step "Frontend lint" { npm run lint }
        Step "Frontend typecheck" { npm run typecheck }
        Step "Frontend production build" { npm run build }
    } finally { Pop-Location }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object {
    $color = if ($_.Value -eq "PASS") { "Green" } else { "Red" }
    Write-Host ("{0,-45} {1}" -f $_.Key, $_.Value) -ForegroundColor $color
}
if ($results.Values -contains "FAIL") { exit 1 }
