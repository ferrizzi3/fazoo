// Onde ficam as fotos, vídeos e áudios dos pedidos.
//
//  - Vercel Blob (produção): usado quando o projeto tem um Blob store conectado
//    (variável BLOB_STORE_ID ou BLOB_READ_WRITE_TOKEN). O navegador envia o arquivo
//    direto para o Blob por um link assinado, sem passar pela função da Vercel.
//  - Local (desenvolvimento e testes): grava em ./data/anexos e imita os links assinados.
//
// Os arquivos são apagados quando o serviço termina (ver index.js) e, como garantia,
// o próprio Blob apaga cada arquivo sozinho depois de TTL_DIAS.
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rm, stat, open } from "node:fs/promises";
import { join, dirname, normalize, sep } from "node:path";

export const TTL_DIAS = 60;
const ENVIO_MIN = 15; // minutos que o link de envio vale
const LEITURA_MIN = 60; // minutos que o link para ver o arquivo vale

export function blobConfigurado() {
  return !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

// ---------- Vercel Blob ----------
function armazenamentoBlob() {
  let mod;
  const sdk = async () => (mod ??= await import("@vercel/blob"));
  const tokensLeitura = new Map(); // caminho -> { token, ate }

  return {
    modo: "blob",
    async urlEnvio({ caminho, mime, max }) {
      const { issueSignedToken, presignUrl } = await sdk();
      const validUntil = Date.now() + ENVIO_MIN * 60000;
      const token = await issueSignedToken({
        pathname: caminho,
        operations: ["put"],
        allowedContentTypes: [mime],
        maximumSizeInBytes: max,
        validUntil,
      });
      const { presignedUrl } = await presignUrl(token, {
        operation: "put",
        pathname: caminho,
        access: "private",
        allowedContentTypes: [mime],
        maximumSizeInBytes: max,
        addRandomSuffix: false,
        allowOverwrite: false,
        ttlDays: TTL_DIAS,
        validUntil,
      });
      return presignedUrl;
    },
    async urlLeitura(caminho) {
      const { issueSignedToken, presignUrl } = await sdk();
      let t = tokensLeitura.get(caminho);
      // issueSignedToken consulta a Vercel; reaproveita o token enquanto ele valer.
      if (!t || t.ate - Date.now() < 10 * 60000) {
        const ate = Date.now() + LEITURA_MIN * 60000;
        t = { token: await issueSignedToken({ pathname: caminho, operations: ["get"], validUntil: ate }), ate };
        tokensLeitura.set(caminho, t);
      }
      const { presignedUrl } = await presignUrl(t.token, { operation: "get", pathname: caminho, access: "private", validUntil: t.ate });
      return presignedUrl;
    },
    async tamanho(caminho) {
      const { head } = await sdk();
      try {
        return (await head(caminho)).size;
      } catch {
        return null;
      }
    },
    async apagar(caminhos) {
      if (!caminhos.length) return;
      const { del } = await sdk();
      await del(caminhos);
      caminhos.forEach((c) => tokensLeitura.delete(c));
    },
  };
}

// ---------- Local ----------
function armazenamentoLocal({ secret, pasta }) {
  const assina = (txt) => createHmac("sha256", secret).update(txt).digest("base64url");
  const confere = (txt, s) => {
    const a = Buffer.from(assina(txt));
    const b = Buffer.from(String(s || ""));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const arquivo = (caminho) => {
    const f = normalize(join(pasta, caminho));
    if (!f.startsWith(normalize(pasta) + sep)) throw new Error("caminho inválido");
    return f;
  };
  const link = (op, caminho, extra, minutos) => {
    const e = Date.now() + minutos * 60000;
    const txt = [op, caminho, extra, e].join("|");
    return `/api/arquivos/${caminho}?op=${op}&x=${encodeURIComponent(extra)}&e=${e}&s=${assina(txt)}`;
  };

  return {
    modo: "local",
    async urlEnvio({ caminho, mime, max }) {
      return link("put", caminho, `${mime},${max}`, ENVIO_MIN);
    },
    async urlLeitura(caminho) {
      return link("get", caminho, "", LEITURA_MIN);
    },
    async tamanho(caminho) {
      try {
        return (await stat(arquivo(caminho))).size;
      } catch {
        return null;
      }
    },
    async apagar(caminhos) {
      for (const c of caminhos) {
        await rm(arquivo(c), { force: true });
        await rm(arquivo(c) + ".tipo", { force: true });
      }
    },
    // Atende os links /api/arquivos/... (só existe no modo local).
    async atende(req, res, url) {
      const caminho = decodeURIComponent(url.pathname.slice("/api/arquivos/".length));
      const q = url.searchParams;
      const op = q.get("op");
      const extra = q.get("x") || "";
      const e = Number(q.get("e"));
      const ok = confere([op, caminho, extra, e].join("|"), q.get("s")) && e > Date.now();
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT", "Access-Control-Allow-Headers": "*" };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return res.end();
      }
      if (!ok) {
        res.writeHead(403, cors);
        return res.end("Link inválido ou expirado");
      }
      const f = arquivo(caminho);
      if (op === "put" && req.method === "PUT") {
        const [mime, max] = extra.split(",");
        const tipo = String(req.headers["content-type"] || "").split(";")[0].trim();
        if (tipo !== mime) {
          res.writeHead(400, cors);
          return res.end("Tipo de arquivo não permitido");
        }
        const partes = [];
        let n = 0;
        for await (const c of req) {
          n += c.length;
          if (n > Number(max)) {
            res.writeHead(413, cors);
            return res.end("Arquivo grande demais");
          }
          partes.push(c);
        }
        try {
          await stat(f);
          res.writeHead(409, cors);
          return res.end("Já existe");
        } catch {}
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, Buffer.concat(partes));
        await writeFile(f + ".tipo", mime);
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        return res.end("{}");
      }
      if (op === "get" && (req.method === "GET" || req.method === "HEAD")) {
        let info;
        try {
          info = await stat(f);
        } catch {
          res.writeHead(404, cors);
          return res.end();
        }
        const tipo = await readFile(f + ".tipo", "utf8").catch(() => "application/octet-stream");
        const total = info.size;
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
        let ini = 0,
          fim = total - 1,
          status = 200;
        if (m) {
          ini = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
          fim = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
          status = 206;
        }
        const h = { ...cors, "Content-Type": tipo, "Accept-Ranges": "bytes", "Content-Length": fim - ini + 1, "Cache-Control": "private, max-age=3600" };
        if (status === 206) h["Content-Range"] = `bytes ${ini}-${fim}/${total}`;
        res.writeHead(status, h);
        if (req.method === "HEAD") return res.end();
        const fh = await open(f);
        const buf = Buffer.alloc(fim - ini + 1);
        await fh.read(buf, 0, buf.length, ini);
        await fh.close();
        return res.end(buf);
      }
      res.writeHead(405, cors);
      res.end();
    },
  };
}

export function criaArmazenamento({ secret, pasta } = {}) {
  if (blobConfigurado()) return armazenamentoBlob();
  // Na Vercel não dá para gravar em disco: sem Blob conectado os anexos ficam desligados.
  if (process.env.VERCEL) return null;
  return armazenamentoLocal({ secret: secret || "dev", pasta: pasta || process.env.ANEXOS_DIR || "./data/anexos" });
}
