import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";

export function hashSenha(senha) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(senha, salt, 64).toString("hex");
}

export function confereSenha(senha, guardado) {
  const [salt, chave] = String(guardado).split(":");
  if (!salt || !chave) return false;
  const a = Buffer.from(chave, "hex");
  const b = scryptSync(senha, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sig = (txt, secret) => createHmac("sha256", secret).update(txt).digest("base64url");

export function assinaToken(payload, secret, dias = 7) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const c = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + dias * 86400 });
  return `${h}.${c}.${sig(h + "." + c, secret)}`;
}

export function verificaToken(token, secret) {
  try {
    const [h, c, s] = token.split(".");
    const esperado = Buffer.from(sig(h + "." + c, secret));
    const recebido = Buffer.from(s);
    if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
    const p = JSON.parse(Buffer.from(c, "base64url").toString());
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}
