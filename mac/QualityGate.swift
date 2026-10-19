// App de Mac do quality-gate: uma janela nativa em volta da tela que o `server.mjs` já serve.
//
// Não reimplementa nada da tela — carrega `http://127.0.0.1:<porta>/` num WKWebView. O que ele
// acrescenta é o que um WKWebView NÃO faz sozinho, e cada item é uma falha calada sem ele:
// `confirm()` devolve false sem mostrar nada (a PR de release nunca abre), `<input type=file>` não
// abre seletor (o `escolher .md…` da primeira abertura morre), `target=_blank` não navega (os links
// do GitHub e do Linear param de funcionar), e sem menu Editar o ⌘C/⌘V não chega aos campos.
//
// A configuração vem do Info.plist que `lib/app.mjs` escreve na construção — clone, node por
// caminho absoluto, PATH assado, porta e rótulo do LaunchAgent —, pelos mesmos motivos do plist do
// LaunchAgent: app aberto pelo Finder herda o PATH mínimo do launchd, sem `nvm` e sem homebrew.
//
// Compilar: `node instalacao/gatilhos.mjs --app` (não chame o swiftc à mão: o binário sem o
// Info.plist da construção não sabe qual clone servir).

import Cocoa
import WebKit

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    enum Origem {
        case jaNoAr, agente, app
    }

    private let info = Bundle.main.infoDictionary ?? [:]
    private var janela: NSWindow!
    private var web: WKWebView!
    private var servidor: Process?
    private var stderrDoServidor = Data()
    private var origem: Origem?
    private var encerrando = false
    private var observacaoTitulo: NSKeyValueObservation?
    private var sinalTerm: DispatchSourceSignal?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    private var clone: String { info["QGClone"] as? String ?? "" }
    private var node: String { info["QGNode"] as? String ?? "/usr/bin/env" }
    private var path: String { info["QGPath"] as? String ?? "/usr/bin:/bin:/usr/sbin:/sbin" }
    private var porta: Int { Int(info["QGPorta"] as? String ?? "") ?? 4100 }
    private var rotulo: String { info["QGRotulo"] as? String ?? "" }
    private var base: URL { URL(string: "http://127.0.0.1:\(porta)/")! }

    func applicationDidFinishLaunching(_ notification: Notification) {
        montarMenu()
        montarJanela()
        // SIGTERM (`kill`, `killall`) não passa pelo `applicationWillTerminate`, e o servidor filho ficaria órfão na porta.
        signal(SIGTERM, SIG_IGN)
        sinalTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sinalTerm?.setEventHandler { NSApp.terminate(nil) }
        sinalTerm?.resume()
        Task { await subirECarregar() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    // Só derruba o servidor que ele mesmo subiu: o do LaunchAgent é de outra pessoa, e matá-lo
    // faria o `KeepAlive` subi-lo de novo de qualquer jeito.
    func applicationWillTerminate(_ notification: Notification) {
        encerrando = true
        servidor?.terminate()
    }

    // MARK: - servidor

    private func subirECarregar() async {
        origem = nil
        mostrarAviso("Conectando à tela na porta \(porta)…", detalhe: clone)
        switch await sondar() {
        case .quality:
            origem = agenteCarregado() ? .agente : .jaNoAr
            carregar(base)
            return
        case .outro:
            mostrarErro("A porta \(porta) responde, mas não é o quality-gate.",
                        detalhe: "Outro programa ocupa a porta. Feche-o, ou reconstrua o app com --porta=<outra>.")
            return
        case .nada:
            break
        }
        if agenteCarregado() {
            origem = .agente
            executar("/bin/launchctl", ["kickstart", "gui/\(getuid())/\(rotulo)"])
        } else if let falha = iniciarServidor() {
            mostrarErro("Não deu para iniciar o servidor.", detalhe: falha)
            return
        } else {
            origem = .app
        }
        for _ in 0..<60 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if await sondar() == .quality {
                carregar(base)
                return
            }
            if origem == .app && servidor?.isRunning != true {
                break
            }
        }
        mostrarErro("A tela não subiu na porta \(porta).", detalhe: diagnostico())
    }

    enum Sonda {
        case quality, outro, nada
    }

    // O ícone é público (fica fora do token) e carrega o nome do projeto: é o jeito barato de
    // distinguir "a tela está no ar" de "alguma coisa está na porta".
    private func sondar() async -> Sonda {
        var pedido = URLRequest(url: base.appendingPathComponent("favicon.svg"))
        pedido.timeoutInterval = 1
        pedido.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (dados, resposta) = try? await URLSession.shared.data(for: pedido) else {
            return .nada
        }
        let corpo = String(decoding: dados, as: UTF8.self)
        return (resposta as? HTTPURLResponse)?.statusCode == 200 && corpo.contains("quality-gate") ? .quality : .outro
    }

    private func agenteCarregado() -> Bool {
        !rotulo.isEmpty && executar("/bin/launchctl", ["print", "gui/\(getuid())/\(rotulo)"]) == 0
    }

    @discardableResult
    private func executar(_ programa: String, _ argumentos: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: programa)
        p.arguments = argumentos
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus
        } catch {
            return -1
        }
    }

    // Node e clone ficam assados no Info.plist: trocar de versão pelo nvm ou mover o clone quebra os dois.
    private func iniciarServidor() -> String? {
        let servidorMjs = (clone as NSString).appendingPathComponent("server.mjs")
        if !FileManager.default.fileExists(atPath: servidorMjs) {
            return "O clone gravado no app não existe mais:\n  \(clone)\n\nReconstrua o app a partir do clone novo:\n  node <clone novo>/instalacao/gatilhos.mjs --app"
        }
        if !FileManager.default.isExecutableFile(atPath: node) {
            return "O node gravado no app não existe mais:\n  \(node)\n\nProvavelmente a versão mudou pelo nvm. Reconstrua o app com o node atual:\n  node \(clone)/instalacao/gatilhos.mjs --app"
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--disable-warning=ExperimentalWarning", servidorMjs]
        p.currentDirectoryURL = URL(fileURLWithPath: clone)
        var ambiente = ProcessInfo.processInfo.environment
        ambiente["PATH"] = path
        ambiente["PORT"] = String(porta)
        p.environment = ambiente
        p.standardOutput = FileHandle.nullDevice
        // Drenado sempre, e não lido só no fim: pipe cheio (64 KB) trava o servidor no próximo `console.error`.
        let erro = Pipe()
        p.standardError = erro
        erro.fileHandleForReading.readabilityHandler = { [weak self] h in
            let pedaco = h.availableData
            // Vazio é EOF, e o handler segue sendo chamado em laço se não for desligado.
            if pedaco.isEmpty {
                h.readabilityHandler = nil
                return
            }
            Task { @MainActor in self?.acumularStderr(pedaco) }
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.servidorParou() }
        }
        do {
            try p.run()
            servidor = p
            return nil
        } catch {
            return "\(node)\n\(error.localizedDescription)"
        }
    }

    private func acumularStderr(_ pedaco: Data) {
        stderrDoServidor.append(pedaco)
        if stderrDoServidor.count > 16_384 {
            stderrDoServidor = stderrDoServidor.suffix(8_192)
        }
    }

    private func servidorParou() {
        if encerrando || origem != .app {
            return
        }
        mostrarErro("O servidor que este app subiu parou.", detalhe: diagnostico())
    }

    private func diagnostico() -> String {
        if origem == .agente {
            let log = (clone as NSString).appendingPathComponent("servico.log")
            let fim = (FileManager.default.contents(atPath: log) ?? Data()).suffix(4_096)
            let texto = String(decoding: fim, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            return "LaunchAgent \(rotulo) · \(log)\n\n" + (texto.isEmpty ? "(log vazio)" : texto)
        }
        let texto = String(decoding: stderrDoServidor, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return texto.isEmpty ? "\(node) \(clone)/server.mjs não escreveu nada no stderr." : texto
    }

    // MARK: - janela

    private func montarJanela() {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isInspectable = true
        web.allowsMagnification = true

        janela = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        janela.title = "Quality Gate"
        janela.minSize = NSSize(width: 720, height: 480)
        janela.contentView = web
        janela.center()
        janela.setFrameAutosaveName("janela-principal")
        janela.makeKeyAndOrderFront(nil)
        NSApp.activate()

        observacaoTitulo = web.observe(\.title) { [weak self] web, _ in
            Task { @MainActor in self?.atualizarTitulo(web.title) }
        }
    }

    private func atualizarTitulo(_ titulo: String?) {
        janela.title = (titulo?.isEmpty == false ? titulo : nil) ?? "Quality Gate"
        switch origem {
        case .agente: janela.subtitle = "porta \(porta) · LaunchAgent"
        case .app: janela.subtitle = "porta \(porta) · servidor deste app — para quando o app fecha"
        case .jaNoAr: janela.subtitle = "porta \(porta)"
        case nil: janela.subtitle = ""
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            janela.makeKeyAndOrderFront(nil)
        }
        return true
    }

    private func carregar(_ url: URL) {
        web.load(URLRequest(url: url))
        atualizarTitulo(web.title)
    }

    private func mostrarAviso(_ titulo: String, detalhe: String) {
        web.loadHTMLString(pagina(titulo, detalhe: detalhe, erro: false), baseURL: nil)
    }

    private func mostrarErro(_ titulo: String, detalhe: String) {
        web.loadHTMLString(pagina(titulo, detalhe: detalhe, erro: true), baseURL: nil)
        atualizarTitulo("Quality Gate")
    }

    private func pagina(_ titulo: String, detalhe: String, erro: Bool) -> String {
        let esc = { (s: String) in
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        return """
        <!doctype html><meta charset="utf-8"><style>
        :root{--fundo:#f6f6f8;--texto:#1d1d24;--fraco:#6b6b78;--borda:#e2e2ea;--marca:#7D70E4;--erro:#c2413a}
        @media (prefers-color-scheme:dark){:root{--fundo:#18181d;--texto:#ececf1;--fraco:#9a9aa8;--borda:#2c2c35}}
        body{margin:0;height:100vh;display:grid;place-items:center;background:var(--fundo);color:var(--texto);
        font:14px -apple-system,BlinkMacSystemFont,sans-serif}
        main{max-width:640px;padding:24px}
        h1{font-size:18px;margin:0 0 12px;color:\(erro ? "var(--erro)" : "var(--texto)")}
        pre{white-space:pre-wrap;word-break:break-word;background:transparent;border:1px solid var(--borda);
        border-radius:8px;padding:12px;color:var(--fraco);font:12px ui-monospace,Menlo,monospace;max-height:50vh;overflow:auto}
        a{display:inline-block;margin-top:12px;padding:6px 14px;border-radius:6px;background:var(--marca);
        color:#fff;text-decoration:none}
        </style><main><h1>\(esc(titulo))</h1><pre>\(esc(detalhe))</pre>
        \(erro ? "<a href=\"quality-gate://tentar\">Tentar de novo (⌘R)</a>" : "")</main>
        """
    }

    // MARK: - navegação

    private func daTela(_ url: URL) -> Bool {
        ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == porta
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, action.targetFrame?.isMainFrame != false else {
            return .allow
        }
        if url.scheme == "quality-gate" {
            Task { await subirECarregar() }
            return .cancel
        }
        if daTela(url) || url.scheme == "about" {
            return .allow
        }
        NSWorkspace.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if daTela(url) {
                webView.load(URLRequest(url: url))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Cancelado (outra carga tomou o lugar) e interrompido pela política (link externo) não são falha.
        let e = error as NSError
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) {
            return
        }
        mostrarErro("A tela não respondeu.", detalhe: e.localizedDescription)
    }

    // MARK: - painéis do JavaScript

    private func alerta(_ mensagem: String) -> NSAlert {
        let a = NSAlert()
        let linhas = mensagem.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        a.messageText = String(linhas.first ?? "")
        a.informativeText = linhas.count > 1 ? String(linhas[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
        return a
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        let a = alerta(message)
        a.addButton(withTitle: "OK")
        _ = await a.beginSheetModal(for: janela)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        let a = alerta(message)
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancelar")
        return await a.beginSheetModal(for: janela) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let a = alerta(prompt)
        let campo = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 24))
        campo.stringValue = defaultText ?? ""
        a.accessoryView = campo
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancelar")
        a.window.initialFirstResponder = campo
        return await a.beginSheetModal(for: janela) == .alertFirstButtonReturn ? campo.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let painel = NSOpenPanel()
        painel.canChooseFiles = true
        painel.canChooseDirectories = parameters.allowsDirectories
        painel.allowsMultipleSelection = parameters.allowsMultipleSelection
        return await painel.beginSheetModal(for: janela) == .OK ? painel.urls : nil
    }

    // MARK: - menu

    @objc private func recarregar(_ sender: Any?) {
        if web.url.map(daTela) == true {
            web.reload()
        } else {
            Task { await subirECarregar() }
        }
    }

    @objc private func abrirNoNavegador(_ sender: Any?) {
        NSWorkspace.shared.open(web.url.flatMap { daTela($0) ? $0 : nil } ?? base)
    }

    @objc private func tamanhoReal(_ sender: Any?) {
        web.pageZoom = 1
    }

    @objc private func aumentar(_ sender: Any?) {
        web.pageZoom = min(web.pageZoom + 0.1, 3)
    }

    @objc private func diminuir(_ sender: Any?) {
        web.pageZoom = max(web.pageZoom - 0.1, 0.5)
    }

    private func montarMenu() {
        let principal = NSMenu()
        let nome = "Quality Gate"

        let app = NSMenu(title: nome)
        app.addItem(withTitle: "Sobre o \(nome)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Ocultar \(nome)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let outros = app.addItem(withTitle: "Ocultar Outros", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        outros.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Mostrar Tudo", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Encerrar \(nome)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editar = NSMenu(title: "Editar")
        editar.addItem(withTitle: "Desfazer", action: Selector(("undo:")), keyEquivalent: "z")
        let refazer = editar.addItem(withTitle: "Refazer", action: Selector(("redo:")), keyEquivalent: "z")
        refazer.keyEquivalentModifierMask = [.command, .shift]
        editar.addItem(.separator())
        editar.addItem(withTitle: "Recortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editar.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editar.addItem(withTitle: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editar.addItem(withTitle: "Selecionar Tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let visualizar = NSMenu(title: "Visualizar")
        visualizar.addItem(withTitle: "Recarregar", action: #selector(recarregar(_:)), keyEquivalent: "r")
        let navegador = visualizar.addItem(withTitle: "Abrir no Navegador", action: #selector(abrirNoNavegador(_:)), keyEquivalent: "o")
        navegador.keyEquivalentModifierMask = [.command, .shift]
        visualizar.addItem(.separator())
        visualizar.addItem(withTitle: "Tamanho Real", action: #selector(tamanhoReal(_:)), keyEquivalent: "0")
        visualizar.addItem(withTitle: "Aumentar", action: #selector(aumentar(_:)), keyEquivalent: "=")
        visualizar.addItem(withTitle: "Diminuir", action: #selector(diminuir(_:)), keyEquivalent: "-")

        let janelaMenu = NSMenu(title: "Janela")
        janelaMenu.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        janelaMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        janelaMenu.addItem(withTitle: "Fechar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        for submenu in [app, editar, visualizar, janelaMenu] {
            let item = NSMenuItem()
            item.submenu = submenu
            principal.addItem(item)
        }
        NSApp.mainMenu = principal
        NSApp.windowsMenu = janelaMenu
    }
}
