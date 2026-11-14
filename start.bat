@echo off
cd /d "%~dp0"
rem The server opens the panel itself (with the access token, if enabled).
set JARVIS_OPEN=1
node server.js
