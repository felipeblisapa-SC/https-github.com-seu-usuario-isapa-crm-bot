<#
Configura, uma unica vez, as credenciais de login do MEX3000 para uso pela
automacao de "Recepcao de Dados" (automatizar_recepcao_dados.ps1).

Como funciona: pede o usuario e a senha e salva num arquivo local
(credenciais_mex3000.xml) criptografado com o DPAPI do Windows - ou seja,
so pode ser lido de volta pelo MESMO usuario do Windows, no MESMO computador,
onde foi salvo. Nao e' texto puro, mas continua sendo um segredo guardado
localmente: qualquer pessoa com acesso a esse login do Windows consegue usar
esse arquivo. Rode isso so em maquinas de confianca.

Uso (uma vez so, ou sempre que a senha do MEX3000 mudar):
    powershell -ExecutionPolicy Bypass -File configurar_credenciais.ps1
#>

$ErrorActionPreference = "Stop"
$destino = Join-Path $PSScriptRoot "credenciais_mex3000.xml"

Write-Host "Configuracao de credenciais do MEX3000 para automacao da Claudia" -ForegroundColor Cyan
Write-Host "Isso vai salvar usuario/senha de forma criptografada em:"
Write-Host "  $destino`n"

$usuario = Read-Host "Usuario do MEX3000 (ex: 8585)"
$senhaSegura = Read-Host "Senha do MEX3000" -AsSecureString

$obj = [PSCustomObject]@{
    Usuario = $usuario
    SenhaSegura = $senhaSegura | ConvertFrom-SecureString
}

$obj | Export-Clixml -Path $destino

Write-Host "`nCredenciais salvas com sucesso." -ForegroundColor Green
Write-Host "Agora pode rodar automatizar_recepcao_dados.ps1 (ou agendar no Task Scheduler)."
