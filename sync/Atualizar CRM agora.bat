@echo off
REM Duplo-clique neste arquivo pra forcar uma atualizacao AGORA do CRM
REM (sem esperar os 30 minutos do loop automatico). Roda uma vez so e fecha.
cd /d "%~dp0"
python sync_to_cloud.py
echo.
echo Atualizacao concluida! Pode fechar esta janela.
pause
