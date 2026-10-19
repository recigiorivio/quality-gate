# App de Windows do quality-gate: a tela numa janela do Edge em modo app (--app), sem barra de
# endereço e com ícone próprio. Par do mac/QualityGate.swift, e com o mesmo contrato.
#
# Ao abrir: se a tela já responde na porta, só abre a janela. Se não, sobe `node server.mjs`
# escondido e o derruba quando a janela fecha. O Edge roda com perfil próprio (--user-data-dir):
# sem ele a janela vira mais uma do Edge que já está aberto, o processo lançado sai na hora, e não
# há como saber quando a janela fechou.
#
# Não rode à mão: `node instalacao/gatilhos.mjs --app` copia este arquivo para
# %LOCALAPPDATA%\QualityGate (com BOM: sem ele o PowerShell 5.1 lê como Windows-1252 e os acentos
# das mensagens saem quebrados), grava o config.json ao lado e cria o atalho no menu Iniciar.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework

$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw -Path (Join-Path $aqui 'config.json') | ConvertFrom-Json
$base = "http://127.0.0.1:$($config.porta)/"
$reconstruir = "node `"$(Join-Path $config.clone 'instalacao\gatilhos.mjs')`" --app"

function Falhar([string]$titulo, [string]$detalhe) {
    [System.Windows.MessageBox]::Show($detalhe, "Quality Gate - $titulo", 'OK', 'Error') | Out-Null
    exit 1
}

# O ícone é público (fica fora do token) e carrega o nome do projeto: distingue "a tela está no ar"
# de "alguma coisa está na porta". Lido pelo fluxo bruto porque o PowerShell 5.1 devolve SVG em bytes.
function Sondar {
    try {
        $r = Invoke-WebRequest -Uri ($base + 'favicon.svg') -UseBasicParsing -TimeoutSec 1
        $corpo = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
        if ($corpo -match 'quality-gate') { return 'quality' }
        return 'outro'
    } catch {
        return 'nada'
    }
}

$servidor = $null
$estado = Sondar
if ($estado -eq 'outro') {
    Falhar 'porta ocupada' "A porta $($config.porta) responde, mas não é o quality-gate.`n`nFeche o outro programa, ou reconstrua o app com outra porta:`n  $reconstruir --porta=<outra>"
}
if ($estado -eq 'nada') {
    $servidorMjs = Join-Path $config.clone 'server.mjs'
    if (-not (Test-Path $servidorMjs)) {
        Falhar 'clone não encontrado' "O clone gravado no app não existe mais:`n  $($config.clone)`n`nReconstrua o app a partir do clone novo:`n  node <clone novo>\instalacao\gatilhos.mjs --app"
    }
    if (-not (Test-Path $config.node)) {
        Falhar 'node não encontrado' "O node gravado no app não existe mais:`n  $($config.node)`n`nProvavelmente a versão mudou. Reconstrua o app com o node atual:`n  $reconstruir"
    }
    $erros = Join-Path $aqui 'servidor.log'
    $env:PORT = [string]$config.porta
    $servidor = Start-Process -FilePath $config.node -WorkingDirectory $config.clone -WindowStyle Hidden -PassThru `
        -ArgumentList @('--disable-warning=ExperimentalWarning', "`"$servidorMjs`"") `
        -RedirectStandardOutput (Join-Path $aqui 'servidor.out.log') -RedirectStandardError $erros
    $subiu = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        if ((Sondar) -eq 'quality') { $subiu = $true; break }
        if ($servidor.HasExited) { break }
    }
    if (-not $subiu) {
        if (-not $servidor.HasExited) { Stop-Process -Id $servidor.Id -Force }
        $fim = if (Test-Path $erros) { (Get-Content $erros -Tail 25) -join "`n" } else { '(sem log)' }
        Falhar 'a tela não subiu' "A tela não subiu na porta $($config.porta).`n`n$fim"
    }
}

$edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
    # Sem Edge não há janela para esperar: o navegador padrão abre, e quem diz quando parar é a pessoa.
    Start-Process $base
    if ($servidor) {
        [System.Windows.MessageBox]::Show("A tela abriu no navegador.`n`nClique em OK para encerrar o servidor que este app subiu.", 'Quality Gate', 'OK', 'Information') | Out-Null
    }
} else {
    $perfil = Join-Path $aqui 'perfil-edge'
    $janela = Start-Process -FilePath $edge -PassThru -ArgumentList @(
        "--app=$base", "--user-data-dir=`"$perfil`"", '--no-first-run', '--no-default-browser-check')
    # Segunda abertura com a primeira janela de pé: o Edge entrega a URL ao processo que já existe e
    # este sai na hora. Sem problema: quem subiu o servidor foi a primeira, e só ela o derruba.
    $janela.WaitForExit()
}

if ($servidor -and -not $servidor.HasExited) {
    Stop-Process -Id $servidor.Id -Force
}
