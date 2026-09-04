@echo off
REM Loop de sincronizacao automatica do CRM Isapa Bike.
REM Roda o sync_to_cloud.py a cada 30 minutos, para sempre, enquanto o PC
REM estiver ligado e voce estiver logado. Criado para substituir o Agendador
REM de Tarefas do Windows, que estava falhando (gaps de varias horas por
REM causa de configuracoes de "gatilho"/"condicoes" e o PC dormindo).
REM
REM Este .bat e iniciado automaticamente pelo iniciar_sync_isapa.vbs (que fica
REM na pasta Inicializar do Windows), de forma invisivel (sem janela preta).

cd /d "%~dp0"

:loop
echo [%date% %time%] Iniciando sincronizacao... >> sync_loop_log.txt
python sync_to_cloud.py >> sync_loop_log.txt 2>&1
echo [%date% %time%] Sincronizacao terminou. Proxima em 30 minutos. >> sync_loop_log.txt
timeout /t 1800 /nobreak > nul
goto loop
