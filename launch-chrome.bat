@echo off
REM Launch a visible Chrome window with remote debugging for WSL2.
REM The window stays visible so the user can manually solve CAPTCHAs.
REM Run this from Windows (cmd or PowerShell)

set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
set DEBUG_PORT=9222
set USER_DATA="%TEMP%\chrome-pi-debug"

echo Starting Chrome with remote debugging on port %DEBUG_PORT%...
echo User data dir: %USER_DATA%
echo.
echo Connect from WSL2 using: http://windows-ip:%DEBUG_PORT%
echo Press Ctrl+C to stop.
echo.

%CHROME_PATH% ^
  --remote-debugging-port=%DEBUG_PORT% ^
  --remote-debugging-address=0.0.0.0 ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-networking ^
  --disable-default-apps ^
  --disable-extensions ^
  --disable-sync ^
  --disable-translate ^
  --user-data-dir=%USER_DATA% ^
  --window-size=1280,900
