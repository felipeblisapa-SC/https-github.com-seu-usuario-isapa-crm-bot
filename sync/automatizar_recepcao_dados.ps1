<#
Automatiza o "Recepcao de Dados" do MEX3000 (Sistema de Vendas):
abre a tela de Conexao, preenche usuario/senha, garante que so "Recepcao dos
Dados" esta marcado (e "Enviar Pedidos"/"Carga completa" desmarcados), clica
em Conectar, e espera terminar.

IMPORTANTE - isso foi escrito a partir de um video da tela, sem poder testar
num Windows de verdade. E bem provavel que precise de ajuste fino na primeira
rodada. Rode manualmente uma vez (sem agendar ainda) e me manda o conteudo de
recepcao_log.txt se der erro, que eu ajusto.

Requisitos:
  - Ja ter rodado configurar_credenciais.ps1 uma vez.
  - O MEX3000 (Sistema de Vendas) precisa conseguir ser aberto pelo caminho
    configurado abaixo em $CaminhoExe.

Uso:
    powershell -ExecutionPolicy Bypass -File automatizar_recepcao_dados.ps1
#>

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# CONFIGURACAO - ajuste se o caminho do programa for diferente na sua maquina
# ---------------------------------------------------------------------------
$CaminhoExe = "C:\MEX3000 -Isapa - Bike\PedidoDeskTop.exe"
$TituloJanelaPrincipal = "Sistema de Vendas"
$TituloJanelaLogin = "Login"
$TituloJanelaConexao = "Conex"   # "Conexão" - sem acento pra nao depender de encoding
$TimeoutAberturaSeg = 90   # tempo total esperando o app abrir (login + carregamento)
$TimeoutDownloadSeg = 600   # 10 minutos - ajuste se a base for grande

$Log = Join-Path $PSScriptRoot "recepcao_log.txt"
function Log($msg) {
    $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - $msg"
    Write-Host $linha
    Add-Content -Path $Log -Value $linha
}

# ---------------------------------------------------------------------------
# Carrega credenciais salvas por configurar_credenciais.ps1
# ---------------------------------------------------------------------------
$credPath = Join-Path $PSScriptRoot "credenciais_mex3000.xml"
if (-not (Test-Path $credPath)) {
    Log "ERRO: credenciais_mex3000.xml nao encontrado. Rode configurar_credenciais.ps1 primeiro."
    exit 1
}
$credObj = Import-Clixml -Path $credPath
$usuario = $credObj.Usuario
$senhaSegura = $credObj.SenhaSegura | ConvertTo-SecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
$senha = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-JanelaPorTitulo($tituloParcial, $timeoutSeg, $elementoExtra = $null) {
    # Procura primeiro entre as janelas de nivel raiz (topo da area de
    # trabalho). Se nao achar e um $elementoExtra foi passado (ex: a janela
    # principal do sistema), tambem procura como descendente dela - alguns
    # formularios "filhos" nao aparecem como janela de nivel raiz.
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condTipo = New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Pane))
    )
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSeg) {
        $janelas = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($j in $janelas) {
            if ($j.Current.Name -like "*$tituloParcial*") {
                return $j
            }
        }
        if ($elementoExtra) {
            try {
                $achadosExtra = $elementoExtra.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condTipo)
                foreach ($a in $achadosExtra) {
                    if ($a.Current.Name -like "*$tituloParcial*") {
                        return $a
                    }
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Find-Descendente($elemento, $controlType, $indice = 0) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType
    )
    $achados = $elemento.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($achados.Count -gt $indice) {
        return $achados.Item($indice)
    }
    return $null
}

function Find-DescendentePorNome($elemento, $controlType, $nomeParcial) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType
    )
    $achados = $elemento.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($a in $achados) {
        if ($a.Current.Name -like "*$nomeParcial*") { return $a }
    }
    return $null
}

# Tenta escrever num campo de texto. Alguns campos (ex: Usuario, quando o
# login "lembra" o ultimo usuario) sao somente-leitura via automacao mesmo
# aceitando digitacao manual - nesse caso nao da pra escrever, so' confere
# se o valor que ja esta la bate com o esperado. Retorna um status em vez
# de estourar excecao, pra o script poder decidir o que fazer.
function Set-Texto($elemento, $texto) {
    try {
        $pattern = $elemento.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    } catch {
        return "sem-suporte"
    }
    if ($pattern.Current.IsReadOnly) {
        return "somente-leitura"
    }
    try {
        $pattern.SetValue($texto)
        return "ok"
    } catch {
        return "erro"
    }
}

function Clicar($elemento) {
    $pattern = $elemento.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}

# So preenche o campo se ele estiver VAZIO. NUNCA sobrescreve um valor que
# ja esteja la - o MEX3000 as vezes lembra o ultimo usuario/senha sozinho,
# e sobrescrever isso com o valor errado (ou desatualizado) do arquivo de
# credenciais foi o que causou falha de login numa das rodadas.
function Preencher-SeVazio($elemento, $valor, $nomeCampo) {
    $valorAtual = ""
    try {
        $pattern = $elemento.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $valorAtual = $pattern.Current.Value
    } catch { }
    if (-not [string]::IsNullOrWhiteSpace($valorAtual)) {
        Log "Campo '$nomeCampo' ja estava preenchido - mantive como estava (nao sobrescrevi)."
        return
    }
    $resultado = Set-Texto $elemento $valor
    if ($resultado -eq "ok") {
        Log "Campo '$nomeCampo' estava vazio - preenchi com a credencial salva."
    } else {
        Log "AVISO: campo '$nomeCampo' estava vazio mas nao consegui preencher ($resultado)."
    }
}

# Abre/aciona um item de menu tentando os padroes possiveis (alguns menus
# classicos do Windows Forms so suportam Expand, outros so suportam Invoke).
function Abrir-ItemMenu($elemento) {
    try {
        $exp = $elemento.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $exp.Expand()
        return $true
    } catch { }
    try {
        $inv = $elemento.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $inv.Invoke()
        return $true
    } catch { }
    try {
        $sel = $elemento.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $sel.Select()
        return $true
    } catch { }
    return $false
}

# ---------------------------------------------------------------------------
# 1. Garante que o MEX3000 esta aberto
# ---------------------------------------------------------------------------
Log "Iniciando automacao de Recepcao de Dados."

$processo = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TituloJanelaPrincipal*" } | Select-Object -First 1
if (-not $processo) {
    Log "Sistema de Vendas nao esta aberto. Abrindo: $CaminhoExe"
    if (-not (Test-Path $CaminhoExe)) {
        Log "ERRO: nao encontrei o executavel em $CaminhoExe. Ajuste a variavel `$CaminhoExe no topo do script."
        exit 1
    }
    Start-Process -FilePath $CaminhoExe
    Start-Sleep -Seconds 5
}

# ---------------------------------------------------------------------------
# 1b. Espera o app abrir de verdade. Fica observando as duas telas possiveis
#     (Login e Sistema de Vendas) ao mesmo tempo, porque o app pode demorar
#     mais que alguns segundos pra desenhar a tela de Login (splash screen,
#     carregamento etc). Se a tela de Login aparecer, preenche e clica
#     Entrar; se "Salvar senha" ja estiver marcado, pode nao aparecer nunca
#     e o app ir direto pra janela principal.
# ---------------------------------------------------------------------------
$janelaPrincipal = $null
$loginTratado = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $TimeoutAberturaSeg) {
    if (-not $loginTratado) {
        $janelaLogin = Get-JanelaPorTitulo $TituloJanelaLogin 1
        if ($janelaLogin) {
            Log "Tela de Login encontrada. Preenchendo credenciais..."
            $campoUsuarioLogin = Find-Descendente $janelaLogin ([System.Windows.Automation.ControlType]::Edit) 0
            $campoSenhaLogin = Find-Descendente $janelaLogin ([System.Windows.Automation.ControlType]::Edit) 1
            if ($campoUsuarioLogin -and $campoSenhaLogin) {
                Preencher-SeVazio $campoUsuarioLogin $usuario "Usuario (Login)"
                Preencher-SeVazio $campoSenhaLogin $senha "Senha (Login)"
                $btnEntrar = Find-DescendentePorNome $janelaLogin ([System.Windows.Automation.ControlType]::Button) "Entrar"
                if ($btnEntrar) {
                    Clicar $btnEntrar
                    Log "Cliquei em Entrar na tela de Login."
                } else {
                    Log "AVISO: nao achei o botao 'Entrar' na tela de Login."
                }
            } else {
                Log "AVISO: nao achei os campos usuario/senha na tela de Login."
            }
            $loginTratado = $true
        }
    }

    $janelaPrincipal = Get-JanelaPorTitulo $TituloJanelaPrincipal 1
    if ($janelaPrincipal) { break }

    Start-Sleep -Milliseconds 500
}

if (-not $loginTratado) {
    Log "Tela de Login nao apareceu (ok, as vezes nao aparece se ja estava logado)."
}
if (-not $janelaPrincipal) {
    Log "ERRO: nao encontrei a janela '$TituloJanelaPrincipal' apos $TimeoutAberturaSeg segundos."
    exit 1
}
Log "Janela principal encontrada: $($janelaPrincipal.Current.Name)"

# ---------------------------------------------------------------------------
# 1c. Traz a janela principal pra frente e garante que nao esta minimizada.
#     Isso importa principalmente quando o script roda sozinho (Agendador
#     de Tarefas, sem ninguem olhando a tela): alguns controles classicos
#     do Windows Forms - como o menu "Arquivo" - nao terminam de se
#     registrar direito na automacao se a janela nunca ganhou foco/redesenho.
# ---------------------------------------------------------------------------
try {
    $winPattern = $janelaPrincipal.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    if ($winPattern.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
        $winPattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
        Log "Janela principal estava minimizada - restaurada."
    }
} catch { }
try {
    $janelaPrincipal.SetFocus()
} catch { }
Start-Sleep -Seconds 2

# ---------------------------------------------------------------------------
# 2. Acha (ou abre) a janela "Conexao"
# ---------------------------------------------------------------------------
$janelaConexao = Get-JanelaPorTitulo $TituloJanelaConexao 5 $janelaPrincipal
if (-not $janelaConexao) {
    Log "Janela de Conexao nao esta aberta ainda. Tentando abrir pelo menu 'Arquivo'..."
    $menuArquivo = Find-DescendentePorNome $janelaPrincipal ([System.Windows.Automation.ControlType]::MenuItem) "Arquivo"
    if ($menuArquivo) {
        if (Abrir-ItemMenu $menuArquivo) {
            Log "Menu 'Arquivo' aberto."
        } else {
            Log "AVISO: nao consegui abrir o menu 'Arquivo' (nenhum padrao suportado)."
        }
        Start-Sleep -Milliseconds 800
        $itemConexao = Find-DescendentePorNome $janelaPrincipal ([System.Windows.Automation.ControlType]::MenuItem) "Conex"
        if ($itemConexao) {
            if (Abrir-ItemMenu $itemConexao) {
                Log "Cliquei no item de menu 'Conexao'."
            } else {
                Log "AVISO: achei o item 'Conexao' no menu mas nao consegui clicar (nenhum padrao suportado)."
            }
        } else {
            Log "AVISO: nao achei o item 'Conexao' dentro do menu 'Arquivo'."
        }
    } else {
        Log "AVISO: nao achei o item de menu 'Arquivo'."
    }
    $janelaConexao = Get-JanelaPorTitulo $TituloJanelaConexao $TimeoutAberturaSeg $janelaPrincipal
}
if (-not $janelaConexao) {
    Log "ERRO: nao consegui abrir/achar a janela de Conexao. Pode ser que o menu tenha nome diferente - ajuste o script ou abra manualmente antes de rodar."
    exit 1
}
Log "Janela de Conexao encontrada."

# ---------------------------------------------------------------------------
# 3. Preenche usuario e senha (os dois primeiros campos de texto da janela)
# ---------------------------------------------------------------------------
$campoUsuario = Find-Descendente $janelaConexao ([System.Windows.Automation.ControlType]::Edit) 0
$campoSenha = Find-Descendente $janelaConexao ([System.Windows.Automation.ControlType]::Edit) 1

if (-not $campoUsuario -or -not $campoSenha) {
    Log "ERRO: nao encontrei os campos de usuario/senha (esperava 2 campos de texto)."
    exit 1
}

Preencher-SeVazio $campoUsuario $usuario "Usuario (Conexao)"
Preencher-SeVazio $campoSenha $senha "Senha (Conexao)"

# ---------------------------------------------------------------------------
# 4. Garante os checkboxes certos: Recepcao dos Dados = marcado,
#    Enviar Pedidos = desmarcado, Carga completa = desmarcado
# ---------------------------------------------------------------------------
function Set-Checkbox($elemento, $deveEstarMarcado) {
    $pattern = $elemento.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $estaMarcado = $pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On
    if ($estaMarcado -ne $deveEstarMarcado) {
        $pattern.Toggle()
    }
}

$chkRecepcao = Find-DescendentePorNome $janelaConexao ([System.Windows.Automation.ControlType]::CheckBox) "Recep"
$chkEnviarPedidos = Find-DescendentePorNome $janelaConexao ([System.Windows.Automation.ControlType]::CheckBox) "Enviar"
$chkCargaCompleta = Find-DescendentePorNome $janelaConexao ([System.Windows.Automation.ControlType]::CheckBox) "Carga"

if ($chkRecepcao) { Set-Checkbox $chkRecepcao $true; Log "Recepcao dos Dados: marcado." }
else { Log "AVISO: nao achei o checkbox 'Recepcao dos Dados' - segue como estiver por padrao." }

if ($chkEnviarPedidos) { Set-Checkbox $chkEnviarPedidos $false; Log "Enviar Pedidos: desmarcado." }
if ($chkCargaCompleta) { Set-Checkbox $chkCargaCompleta $false; Log "Carga completa: desmarcado." }

# ---------------------------------------------------------------------------
# 5. Clica em Conectar
# ---------------------------------------------------------------------------
$btnConectar = Find-DescendentePorNome $janelaConexao ([System.Windows.Automation.ControlType]::Button) "Conectar"
if (-not $btnConectar) {
    Log "ERRO: nao encontrei o botao 'Conectar'."
    exit 1
}
Clicar $btnConectar
Log "Cliquei em Conectar. Aguardando a atualizacao terminar..."

# Fecha qualquer popup de confirmacao tipo "Atualizacao Concluida com
# Sucesso!" que tenha um botao "OK" - sem isso o script ficaria esperando
# pra sempre com o popup travando a tela.
function Fechar-PopupOk {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $janelas = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($j in $janelas) {
        try {
            $btnOk = Find-DescendentePorNome $j ([System.Windows.Automation.ControlType]::Button) "OK"
            if ($btnOk -and $btnOk.Current.IsEnabled) {
                Clicar $btnOk
                return $true
            }
        } catch { }
    }
    return $false
}

# ---------------------------------------------------------------------------
# 6. Espera terminar: o botao Conectar volta a ficar habilitado quando o
#    processo termina (durante o download/importacao ele fica desabilitado
#    e aparece um botao "Cancelar" no lugar). No final aparece um popup
#    "Atualizacao Concluida com Sucesso!" que precisa ser fechado (OK).
# ---------------------------------------------------------------------------
Start-Sleep -Seconds 3
$sw = [Diagnostics.Stopwatch]::StartNew()
$terminou = $false
while ($sw.Elapsed.TotalSeconds -lt $TimeoutDownloadSeg) {
    if (Fechar-PopupOk) {
        # O popup "Atualizacao Concluida com Sucesso!" so' aparece quando a
        # recepcao terminou - isso ja' e' o sinal de fim. (Antes o script
        # ficava esperando o botao Conectar reabilitar, o que nesta versao
        # do MEX3000 nao acontece de forma confiavel e travava ate' o timeout.)
        Log "Popup de confirmacao fechado (cliquei OK) - recepcao terminou."
        Start-Sleep -Seconds 2
        $terminou = $true
        break
    }
    try {
        $btnConectarAtual = Find-DescendentePorNome $janelaConexao ([System.Windows.Automation.ControlType]::Button) "Conectar"
        if ($btnConectarAtual -and $btnConectarAtual.Current.IsEnabled) {
            $terminou = $true
            break
        }
    } catch {
        # a janela de Conexao pode ter fechado sozinha ao terminar
        $aindaExiste = Get-JanelaPorTitulo $TituloJanelaConexao 1 $janelaPrincipal
        if (-not $aindaExiste) {
            Log "Janela de Conexao fechou - considerando a recepcao terminada."
            $terminou = $true
            break
        }
    }
    Start-Sleep -Seconds 3
}

# depois de detectar o fim, confere mais uma vez se sobrou algum popup
# (as vezes o popup aparece so' depois do botao Conectar reabilitar)
Start-Sleep -Seconds 1
if (Fechar-PopupOk) {
    Log "Popup de confirmacao final fechado (cliquei OK)."
}

if ($terminou) {
    Log "Recepcao de Dados concluida (botao Conectar voltou a ficar habilitado)."
} else {
    Log "AVISO: passou de $TimeoutDownloadSeg segundos sem confirmar o termino. Pode ainda estar rodando, ou pode ter travado - confira manualmente."
}

Log "Fim da automacao."
