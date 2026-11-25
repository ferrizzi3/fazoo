// Função da Vercel: recebe tudo que começa com /api e também /health (ver vercel.json).
import { criaManipulador } from "../server/index.js";
import { bancoDoAmbiente } from "../server/db.js";

export default criaManipulador({
  obterBanco: bancoDoAmbiente(),
  secret: process.env.JWT_SECRET,
});
