; Installer hooks for the "PDF Editor Pro" printer (electron-builder includes
; build/installer.nsh automatically).
;
; The printer is Windows' own "Microsoft Print To PDF" driver writing to a
; named-pipe port; electron/print-listener.cjs serves the pipe and opens each
; job in the app (see electron/main.cjs). Adding a printer needs administrator
; rights and this installer is per-user, so ONLY that step is elevated: the
; setup script runs in PowerShell started with "runas", which shows the UAC
; prompt. It is started from the installer, never from the app — Sophos treats
; the app as a PDF reader and blocks it from starting other programs.

!define PDFEP_PRINTER_KEY "SYSTEM\CurrentControlSet\Control\Print\Printers\PDF Editor Pro"
!define PDFEP_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define PDFEP_PRINTER_LOG "$TEMP\PDF Editor Pro - impresora.log"
; LOGIN_ITEM in electron/main.cjs: the logon entry that starts the listener.
!define PDFEP_LOGIN_ITEM "PDF Editor Pro - Impresora"

; _CHECK_APP_RUNNING needs these, and allowOnlyOneInstallerInstance.nsh only
; provides them when customCheckAppRunning is NOT defined.
!include "getProcessInfo.nsh"
Var pid

; The listener runs from this same executable, so the stock check took it for
; the app: "PDF Editor Pro is running" with every window closed, and its file
; held open during an update. Stop the listener first, silently; the stock
; check then deals with real windows exactly as before.
!macro customCheckAppRunning
  nsExec::Exec `"${PDFEP_POWERSHELL}" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.CommandLine -and $$_.CommandLine.Contains('print-listener') -and $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  ; Offered whenever it is missing, i.e. each time the installer runs without it.
  ClearErrors
  ReadRegStr $R0 HKLM "${PDFEP_PRINTER_KEY}" "Name"
  ${If} ${Errors}
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "¿Instalar también la impresora «PDF Editor Pro»?$\r$\n$\r$\nCon ella, «Imprimir» en cualquier programa (SAP, Excel, el navegador...) crea un PDF y lo abre en PDF Editor Pro, como la impresora de PDF24.$\r$\n$\r$\nWindows pedirá permiso de administrador para agregarla." IDNO pdfepNoPrinter
    ExecShellWait "runas" "${PDFEP_POWERSHELL}" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\printer\install-printer.ps1" -Log "${PDFEP_PRINTER_LOG}"' SW_HIDE
    ClearErrors
    ReadRegStr $R0 HKLM "${PDFEP_PRINTER_KEY}" "Name"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "No se instaló la impresora «PDF Editor Pro» (se necesita el permiso de administrador).$\r$\n$\r$\nEl programa funciona igual; para agregar la impresora más adelante, ejecute de nuevo este instalador.$\r$\n$\r$\nDetalles: ${PDFEP_PRINTER_LOG}"
    ${EndIf}
    pdfepNoPrinter:
  ${EndIf}

  ; Printer present: start its listener now (the app registers it for every
  ; logon). Started as the user, never elevated — it opens the app.
  ClearErrors
  ReadRegStr $R0 HKLM "${PDFEP_PRINTER_KEY}" "Name"
  ${IfNot} ${Errors}
    ${StdUtils.ExecShellAsUser} $R0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--print-listener"
  ${EndIf}
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller too: keep the printer through it.
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PDFEP_LOGIN_ITEM}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${PDFEP_LOGIN_ITEM}"
    ClearErrors
    ReadRegStr $R0 HKLM "${PDFEP_PRINTER_KEY}" "Name"
    ${IfNot} ${Errors}
    ${AndIfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Se quitará también la impresora «PDF Editor Pro». Windows pedirá permiso de administrador."
      ExecShellWait "runas" "${PDFEP_POWERSHELL}" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\printer\uninstall-printer.ps1" -Log "${PDFEP_PRINTER_LOG}"' SW_HIDE
    ${EndIf}
  ${EndIf}
!macroend
