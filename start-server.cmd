@echo off
setlocal
set "APP_DIR=%~dp0"
set "PY=C:\Users\27428\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%PY%" (
  "%PY%" -m http.server 4173 --bind 0.0.0.0 --directory "%APP_DIR%"
) else (
  py -m http.server 4173 --bind 0.0.0.0 --directory "%APP_DIR%"
)
