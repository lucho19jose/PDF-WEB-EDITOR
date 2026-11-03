# Removes the "PDF Editor Pro" printer and its port. Run ELEVATED, by the
# uninstaller (build/installer.nsh). Keep this file ASCII (see install-printer.ps1).

param(
  [string]$Log = (Join-Path $env:TEMP 'PDF Editor Pro - impresora.log')
)

$ErrorActionPreference = 'Stop'
$PrinterName = 'PDF Editor Pro'
$PortName = '\\.\pipe\PDFEditorPro'

function Say([string]$Message) {
  try { "$(Get-Date -Format s)  $Message" | Out-File -FilePath $Log -Append -Encoding utf8 } catch { }
}

try {
  if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) {
    # Jobs still queued would hold the printer.
    Get-PrintJob -PrinterName $PrinterName -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
    Remove-Printer -Name $PrinterName
    Say "Printer removed"
  }
  # The spooler lets go of a port a moment after its last printer goes.
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue)) { break }
    try { Remove-PrinterPort -Name $PortName; Say "Port removed"; break } catch { Start-Sleep -Milliseconds 500 }
  }
  exit 0
} catch {
  Say "FAILED: $($_.Exception.Message)"
  exit 1
}
