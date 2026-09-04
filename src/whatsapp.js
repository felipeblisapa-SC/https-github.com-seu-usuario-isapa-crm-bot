"use strict";

const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

// IMPORTANTE: esta pasta precisa estar num volume persistente no Railway,
// senao a sessao do WhatsApp se perde a cada deploy/restart e e' preciso
// escanear o QR code de novo. Ver README.md.
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, "..", "data", "auth");

let sockAtual = null;

// onTextoRecebido(numero, texto) -> resposta em texto (ou null pra nao responder)
// onDocumentoRecebido(numero, buffer, nomeArquivo) -> resposta em texto (ou null),
//   usado hoje pro fluxo de reenvio manual do PDF de estoque da OGGI (ver oggi.js) -
//   sem isso o Baileys simplesmente ignorava qualquer arquivo/documento recebido.
async function iniciarConexao(onTextoRecebido, onDocumentoRecebido) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Claudia CRM Isapa", "Chrome", "1.0"],
  });
  sockAtual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n=== ESCANEIE ESTE QR CODE NO WHATSAPP (Aparelhos conectados > Conectar aparelho) ===\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `[whatsapp] conexao encerrada (codigo ${statusCode}). ` +
          (deveReconectar ? "Tentando reconectar..." : "Sessao deslogada - apague a pasta de auth e escaneie o QR novamente.")
      );
      if (deveReconectar) {
        setTimeout(() => iniciarConexao(onTextoRecebido, onDocumentoRecebido), 3000);
      }
    } else if (connection === "open") {
      console.log("[whatsapp] conectado com sucesso.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || "";
        if (jid.endsWith("@g.us")) continue; // por padrao, ignora mensagens de grupo
        if (jid === "status@broadcast") continue;

        const numero = jid.split("@")[0];

        // Documento (PDF, normalmente) - hoje usado pro reenvio manual do
        // estoque diario da OGGI, enquanto nao ha leitura automatica do
        // Gmail a partir do servidor. Ver oggi.js / server.js.
        const doc = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
        if (doc && onDocumentoRecebido) {
          try {
            const buffer = await downloadMediaMessage(msg, "buffer", {});
            const nomeArquivo = doc.fileName || "arquivo.pdf";
            const resposta = await onDocumentoRecebido(numero, buffer, nomeArquivo);
            if (resposta) await sock.sendMessage(jid, { text: resposta });
          } catch (e) {
            console.error("[whatsapp] erro baixando documento:", e);
            await sock.sendMessage(jid, { text: "Recebi o arquivo mas deu um erro tentando processar. Pode tentar reenviar?" });
          }
          continue;
        }

        const texto =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          "";
        if (!texto.trim()) continue;

        const resposta = await onTextoRecebido(numero, texto.trim());
        if (resposta) {
          await sock.sendMessage(jid, { text: resposta });
        }
      } catch (e) {
        console.error("[whatsapp] erro processando mensagem:", e);
      }
    }
  });

  return sock;
}

function conexaoAtiva() {
  return sockAtual !== null;
}

function toJid(numeroOuJid) {
  return numeroOuJid.includes("@") ? numeroOuJid : `${numeroOuJid}@s.whatsapp.net`;
}

// Envia uma imagem (Buffer PNG/JPEG) com legenda para um numero/jid.
// numeroOuJid pode ser so o numero (ex: "5548999990000") ou o jid completo.
async function enviarImagem(numeroOuJid, bufferImagem, legenda) {
  if (!sockAtual) throw new Error("WhatsApp nao esta conectado.");
  await sockAtual.sendMessage(toJid(numeroOuJid), { image: bufferImagem, caption: legenda || "" });
}

// Envia uma mensagem de texto simples (fora do fluxo normal de resposta).
async function enviarTexto(numeroOuJid, texto) {
  if (!sockAtual) throw new Error("WhatsApp nao esta conectado.");
  await sockAtual.sendMessage(toJid(numeroOuJid), { text: texto });
}

module.exports = { iniciarConexao, conexaoAtiva, enviarImagem, enviarTexto };
