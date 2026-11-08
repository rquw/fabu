; fabu used to be an Electron app installed in a different folder.
; Remove that old copy first, so people don't end up with two fabus and a
; shortcut that still opens the old one. Settings and projects are not touched.

Var FabuOldDesktopLink

!macro NSIS_HOOK_PREINSTALL
  StrCpy $FabuOldDesktopLink "0"
  IfFileExists "$DESKTOP\fabu.lnk" 0 +2
    StrCpy $FabuOldDesktopLink "1"
  IfFileExists "$LOCALAPPDATA\Programs\fabu\Uninstall fabu.exe" 0 fabu_no_old
    ExecWait '"$LOCALAPPDATA\Programs\fabu\Uninstall fabu.exe" /S _?=$LOCALAPPDATA\Programs\fabu'
    RMDir /r "$LOCALAPPDATA\Programs\fabu"
  fabu_no_old:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; the old uninstaller takes the desktop shortcut with it, put it back
  StrCmp $FabuOldDesktopLink "1" 0 +2
    CreateShortCut "$DESKTOP\fabu.lnk" "$INSTDIR\fabu.exe"
!macroend
