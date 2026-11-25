// Servidor de arquivos estáticos, usado só no modo local (npm start).
// Na Vercel a pasta public/ é servida pela própria plataforma.
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SEGURANCA } from "./index.js";

const PUB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function servePublic(path, res) {
  let rel;
  try {
    rel = normalize(decodeURIComponent(path));
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (rel === sep || rel === "/") rel = "/index.html";
  const full = join(PUB, rel);
  if (!full.startsWith(PUB + sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const dados = await readFile(full);
    res.writeHead(200, { "Content-Type": TIPOS[extname(full)] || "application/octet-stream", ...SEGURANCA });
    res.end(dados);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Não encontrado");
  }
}
