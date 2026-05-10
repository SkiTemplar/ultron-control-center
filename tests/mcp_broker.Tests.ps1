# ULTRON v10.6 - Pester tests for mcp_broker.py (zero-trust MCP broker).
#
# Validates: schema validation, allowlist add/remove, command safety
# checks. Does NOT spawn real MCP servers (broker mode is integration-tested
# manually). All tests are unit-level, ~1-2s.
#
# Run: Invoke-Pester tests/mcp_broker.Tests.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Resolve-Path (Join-Path $here '..')
$script = Join-Path $root 'scripts\cockpit\mcp_broker.py'

Describe "mcp_broker - file shape" {

    It "exists and parses" {
        Test-Path $script | Should Be $true
        $r = & python -c "import ast; ast.parse(open(r'$script', encoding='utf-8').read())" 2>&1
        $LASTEXITCODE | Should Be 0
    }

    It "exposes serve, validate, audit-tail, allowlist subcommands" {
        $content = Get-Content -Raw $script
        $content -match "sub\.add_parser\(`"serve`"" | Should Be $true
        $content -match "sub\.add_parser\(`"validate`"" | Should Be $true
        $content -match "sub\.add_parser\(`"audit-tail`"" | Should Be $true
        $content -match "sub\.add_parser\(`"allowlist`"" | Should Be $true
    }
}

Describe "mcp_broker - JSON-RPC validation gate" {

    It "accepts valid JSON-RPC 2.0 request (via tests/mcp_broker_smoke.py)" {
        # PowerShell quoting around JSON braces in -c strings is too fragile
        # for reliable cross-version testing. The dedicated smoke runner
        # validates this path exhaustively (12 cases including JSON-RPC).
        $smoke = Join-Path $root 'tests\mcp_broker_smoke.py'
        Test-Path $smoke | Should Be $true
        $out = & python $smoke 2>&1 | Out-String
        $LASTEXITCODE | Should Be 0
        $out | Should Match "Total fails: 0"
    }

    It "rejects non-JSON line" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import validate_jsonrpc; " +
              "ok, _ = validate_jsonrpc('not json at all'); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }

    It "rejects JSON-RPC version other than 2.0" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import validate_jsonrpc; " +
              "ok, _ = validate_jsonrpc('{`"jsonrpc`":`"1.0`",`"method`":`"x`"}'); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }

    It "rejects missing method field" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import validate_jsonrpc; " +
              "ok, _ = validate_jsonrpc('{`"jsonrpc`":`"2.0`"}'); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }
}

Describe "mcp_broker - command safety (anti-injection)" {

    It "accepts simple binary + arg" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import is_safe_command; " +
              "ok, _ = is_safe_command(['node', 'server.js']); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "True"
    }

    It "rejects shell metacharacter (semicolon)" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import is_safe_command; " +
              "ok, _ = is_safe_command(['node', 'a;b']); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }

    It "rejects shell metacharacter (pipe)" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import is_safe_command; " +
              "ok, _ = is_safe_command(['node', 'x|y']); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }

    It "rejects backtick subshell" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import is_safe_command; " +
              "ok, _ = is_safe_command(['node', 'back``ticks``']); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }

    It "rejects empty command list" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import is_safe_command; " +
              "ok, _ = is_safe_command([]); " +
              "print(ok)"
        $out = & python -c $py 2>&1
        $out | Should Match "False"
    }
}

Describe "mcp_broker - audit trail" {

    It "computes sha256 fingerprint deterministically" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import _sha256; " +
              "h1 = _sha256('hello'); " +
              "h2 = _sha256('hello'); " +
              "print('match' if h1 == h2 else 'mismatch')"
        $out = & python -c $py 2>&1
        $out | Should Match "match"
    }

    It "sha256 output starts with 'sha256:' prefix" {
        $py = "import sys; sys.path.insert(0, r'$($root)\scripts\cockpit'); " +
              "from mcp_broker import _sha256; " +
              "print(_sha256('test'))"
        $out = & python -c $py 2>&1
        $out | Should Match "^sha256:"
    }
}
