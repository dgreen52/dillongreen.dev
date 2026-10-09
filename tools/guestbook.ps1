<#
.SYNOPSIS
  Moderate the dillongreen.dev guestbook and read the studio waitlist (Cloudflare D1).

.DESCRIPTION
  Thin wrapper around `npx wrangler d1 execute dillongreen-db --remote --command "..."`.
  Ids must be positive integers; nothing else from the command line is put into SQL.

.EXAMPLE
  .\tools\guestbook.ps1 list-pending
  .\tools\guestbook.ps1 approve 12
  .\tools\guestbook.ps1 delete 13
  .\tools\guestbook.ps1 list-approved
  .\tools\guestbook.ps1 list-waitlist
  .\tools\guestbook.ps1 delete-waitlist 4      # for a privacy deletion request
  .\tools\guestbook.ps1 list-pending -Local    # against the local dev database instead
#>
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("list-pending", "list-approved", "approve", "delete", "list-waitlist", "delete-waitlist")]
  [string]$Command,

  [Parameter(Position = 1)]
  [string]$Id,

  # Use the local D1 (wrangler pages dev) instead of the live database.
  [switch]$Local
)

$ErrorActionPreference = "Stop"

function Get-EntryId([string]$raw) {
  if ($raw -notmatch '^[1-9][0-9]{0,9}$') {
    throw "'$Command' needs a numeric id, e.g. .\tools\guestbook.ps1 $Command 12"
  }
  return [int64]$raw
}

function Invoke-D1([string]$sql) {
  $target = if ($Local) { "--local" } else { "--remote" }
  # $env:WRANGLER can point at a specific wrangler (e.g. "node C:\path\wrangler.js"); default is npx.
  $wrangler = if ($env:WRANGLER) { $env:WRANGLER } else { "npx wrangler" }
  $portfolio = Split-Path -Parent $PSScriptRoot
  Push-Location $portfolio
  try {
    $parts = $wrangler -split ' '
    $exe = $parts[0]
    $pre = @()
    if ($parts.Length -gt 1) { $pre = $parts[1..($parts.Length - 1)] }
    & $exe @pre d1 execute dillongreen-db $target --command $sql
    if ($LASTEXITCODE -ne 0) { throw "wrangler exited with code $LASTEXITCODE" }
  }
  finally { Pop-Location }
}

switch ($Command) {
  "list-pending" {
    Invoke-D1 "SELECT id, created_at, name, url, message FROM guestbook WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 100"
  }
  "list-approved" {
    Invoke-D1 "SELECT id, created_at, name, url, message FROM guestbook WHERE status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 100"
  }
  "approve" {
    $n = Get-EntryId $Id
    Invoke-D1 "UPDATE guestbook SET status = 'approved' WHERE id = $n AND status = 'pending'"
  }
  "delete" {
    $n = Get-EntryId $Id
    Invoke-D1 "DELETE FROM guestbook WHERE id = $n"
  }
  "list-waitlist" {
    Invoke-D1 "SELECT id, created_at, email, role, org_size, notify, workflow FROM waitlist ORDER BY created_at DESC, id DESC LIMIT 200"
  }
  "delete-waitlist" {
    $n = Get-EntryId $Id
    Invoke-D1 "DELETE FROM waitlist WHERE id = $n"
  }
}
