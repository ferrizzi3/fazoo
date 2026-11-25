// Servidor local (npm start). Na Vercel quem responde é api/index.js.
import http from "node:http";
import { criaManipulador } from "./index.js";
import { bancoDoAmbiente } from "./db.js";
import { servePublic } from "./static.js";

const prod = process.env.NODE_ENV === "production";
const secret = process.env.JWT_SECRET || (prod ? "" : "segredo-so-para-desenvolvimento");
if (!secret) {
  console.error("Defina a variável JWT_SECRET.");
  process.exit(1);
}

const manipulador = criaManipulador({ obterBanco: bancoDoAmbiente(), secret });
const porta = Number(process.env.PORT) || 3000;

http
  .createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/health" || path.startsWith("/api/")) return manipulador(req, res);
    return servePublic(path, res);
  })
  .listen(porta, () => console.log(`Fazoo rodando em http://localhost:${porta}`));
