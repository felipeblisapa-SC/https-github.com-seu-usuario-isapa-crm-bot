<#
Roda o ciclo completo de atualizacao, pensado para ser chamado a cada 2 horas
pelo Agendador de Tarefas do Windows:

  1. Recepcao de Dados no MEX3000 (automatizar_recepcao_dados.ps1)
  2. Envio dos dados atualizados para o servidor da Claudia (sync_to_cloud.py)

Uso (registrar isso no Agendador de Tarefas, nao rodar so na mao):
    powershell -ExecutionPolicy Bypass -File executar_ciclo_completo.ps1
#>

$ErrorActionPreference = "Continue"
$Log = Join-Path $PSScriptRoot "ciclo_log.txt"
function Log($msg) {
    $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg"
    Write-Host $linha
    Add-Content -Path $Log -Value $linha
}

Log "===== INICIO DO CICLO ====="

Log "Passo 1/2: Recepcao de Dados no MEX3000..."
try {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "automatizar_recepcao_dados.ps1")
    Log "Passo 1/2 concluido."
} catch {
    Log "ERRO no passo 1/2 (Recepcao de Dados): $_"
}

# dá um tempo pra garantir que o SFA.DB terminou de ser gravado no disco
Start-Sleep -Seconds 10

Log "Passo 2/2: Enviando dados atualizados para o servidor..."
try {
    & python (Join-Path $PSScriptRoot "sync_to_cloud.py")
    Log "Passo 2/2 concluido."
} catch {
    Log "ERRO no passo 2/2 (sync_to_cloud.py): $_"
}

Log "===== FIM DO CICLO ====="
