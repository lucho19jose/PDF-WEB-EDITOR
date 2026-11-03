# Installs the "PDF Editor Pro" printer. Run ELEVATED, by the installer
# (build/installer.nsh), never by the app: Sophos blocks the app from starting
# other programs, PowerShell above all.
#
# The printer is Windows' own "Microsoft Print To PDF" driver writing to a
# local port that is a named pipe. electron/print-listener.cjs serves the pipe
# and opens each job in the editor. No driver of our own is installed.
#
# Keep this file ASCII: Windows PowerShell 5.1 reads a BOM-less file in the
# ANSI code page.

param(
  [string]$Log = (Join-Path $env:TEMP 'PDF Editor Pro - impresora.log')
)

$ErrorActionPreference = 'Stop'
$PrinterName = 'PDF Editor Pro'
$PortName = '\\.\pipe\PDFEditorPro'      # must match PIPE in electron/print-listener.cjs
$DriverName = 'Microsoft Print To PDF'

function Say([string]$Message) {
  try { "$(Get-Date -Format s)  $Message" | Out-File -FilePath $Log -Append -Encoding utf8 } catch { }
}

try {
  Say "Installing printer '$PrinterName' on port $PortName"

  if (-not (Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue)) {
    # The driver ships with Windows 10/11 as an optional feature, on by default.
    Say "Driver '$DriverName' missing: enabling Printing-PrintToPDFServices-Features"
    Enable-WindowsOptionalFeature -Online -FeatureName 'Printing-PrintToPDFServices-Features' -All -NoRestart | Out-Null
    if (-not (Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue)) {
      Add-PrinterDriver -Name $DriverName
    }
  }

  if (-not (Get-PrinterPort -Name $PortName -ErrorAction SilentlyContinue)) {
    Add-PrinterPort -Name $PortName
    Say "Port added"
  }

  $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
  if ($printer) {
    if ($printer.PortName -ne $PortName -or $printer.DriverName -ne $DriverName) {
      Set-Printer -Name $PrinterName -DriverName $DriverName -PortName $PortName
      Say "Printer repaired"
    } else {
      Say "Printer already installed"
    }
  } else {
    Add-Printer -Name $PrinterName -DriverName $DriverName -PortName $PortName `
      -Comment 'Crea un PDF desde cualquier programa y lo abre en PDF Editor Pro'
    Say "Printer added"
  }
  exit 0
} catch {
  Say "FAILED: $($_.Exception.Message)"
  exit 1
}
