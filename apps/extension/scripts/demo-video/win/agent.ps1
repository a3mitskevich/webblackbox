# Entry point for the Windows side of the demo-video recorder (PowerShell 5.1).
#   -Mode agent     desktop input + UI Automation agent (JSON lines over stdin/stdout)
#   -Mode watchdog  abort watchdog (Escape / cursor in a screen corner)
param(
  [Parameter(Mandatory = $true)][ValidateSet("agent", "watchdog")][string]$Mode
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sources = @((Join-Path $here "Agent.cs"), (Join-Path $here "Watchdog.cs"))
Add-Type -Path $sources -ReferencedAssemblies @(
  "System.Web.Extensions", "UIAutomationClient", "UIAutomationTypes", "WindowsBase"
)
if ($Mode -eq "agent") { [Wbb.Agent]::Run() } else { [Wbb.Watchdog]::Run() }
