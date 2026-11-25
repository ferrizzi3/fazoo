import { hashSenha, confereSenha, assinaToken, verificaToken } from "./auth.js";
import { pagamentos } from "./payments.js";

const CATEGORIAS = ["Ar-condicionado", "Reparo elétrico", "Encanamento", "Construção civil", "Pintura"];
const TAXA = 0.1; // 10% pagos pelo cliente por cima do orçamento

class Erro extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

export const SEGURANCA = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEGURANCA });
  res.end(JSON.stringify(obj));
}

async function corpo(req) {
  if (req.body !== undefined) {
    // Na Vercel o corpo já chega lido.
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
    try {
      return JSON.parse(String(req.body) || "{}");
    } catch {
      throw new Erro(400, "JSON inválido");
    }
  }
  let n = 0;
  const partes = [];
  for await (const c of req) {
    n += c.length;
    if (n > 1e5) throw new Erro(413, "Requisição grande demais");
    partes.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString() || "{}");
  } catch {
    throw new Erro(400, "JSON inválido");
  }
}

function texto(v, campo, min, max) {
  const s = String(v ?? "").trim();
  if (s.length < min || s.length > max) throw new Erro(400, `${campo}: use entre ${min} e ${max} caracteres`);
  return s;
}

const iniciais = (nome) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");

const exige = (u, papel) => {
  if (u.papel !== papel) throw new Erro(403, "Ação não permitida para o seu tipo de conta");
};

// Retorna uma função (req, res) para servidor Node comum ou função da Vercel.
export function criaManipulador({ obterBanco, secret }) {
  const tentativas = new Map();
  function limite(req) {
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
    const agora = Date.now();
    const lista = (tentativas.get(ip) || []).filter((t) => agora - t < 60000);
    lista.push(agora);
    tentativas.set(ip, lista);
    if (lista.length > 20) throw new Erro(429, "Muitas tentativas. Aguarde um minuto.");
  }

  async function api(req, res, path) {
    const db = await obterBanco();
    const { all, one, run, ins, tx } = db;
    const m = req.method;

    async function reputacao(proId) {
      const r = await one(
        `SELECT COUNT(*) AS c, AVG(p.nota) AS m FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_aceito WHERE o.pro_id = ? AND p.status = 'fin'`,
        proId
      );
      const c = Number(r.c);
      if (!c) return "Novo no Fazoo";
      const nota = r.m == null ? "Sem avaliações" : Number(r.m).toFixed(1).replace(".", ",");
      return `${nota} · ${c} serviço${c > 1 ? "s" : ""}`;
    }

    async function fmt(p, u, rep) {
      let orcs = await all(
        `SELECT o.*, us.nome FROM orcamentos o JOIN usuarios us ON us.id = o.pro_id WHERE o.pedido_id = ? ORDER BY o.id`,
        p.id
      );
      const jaOrcou = orcs.some((o) => o.pro_id === u.id);
      const norc = orcs.length;
      if (u.papel === "profissional") orcs = orcs.filter((o) => o.pro_id === u.id);
      const aceito = p.orcamento_aceito != null;
      const meu = u.papel === "profissional" && aceito && orcs.some((o) => o.id === p.orcamento_aceito);
      const ac = aceito ? orcs.findIndex((o) => o.id === p.orcamento_aceito) : -1;
      const repDe = (id) => {
        if (!rep.has(id)) rep.set(id, reputacao(id));
        return rep.get(id);
      };
      const lista = await Promise.all(
        orcs.map(async (o) => ({
          id: o.id,
          p: o.nome,
          i: iniciais(o.nome),
          n: await repDe(o.pro_id),
          v: o.valor / 100,
          z: o.prazo,
          m: o.mensagem,
        }))
      );
      let ch = [];
      let pg = null;
      if (aceito) {
        ch = (await all(`SELECT papel, texto FROM mensagens WHERE pedido_id = ? ORDER BY id`, p.id)).map((x) => ({
          w: x.papel === "cliente" ? "c" : "p",
          t: x.texto,
        }));
        const r = await one(`SELECT total, taxa, status FROM pagamentos WHERE pedido_id = ?`, p.id);
        if (r) pg = { total: r.total / 100, taxa: r.taxa / 100, status: r.status };
      }
      return {
        id: p.id,
        t: p.titulo,
        c: p.categoria,
        d: p.descricao,
        st: p.status,
        orc: lista,
        norc,
        ac: ac < 0 ? null : ac,
        ch,
        av: p.nota || 0,
        avt: p.comentario || "",
        cn: !!p.concluido,
        meu,
        jaOrcou,
        pg,
      };
    }

    async function usuarioDoToken() {
      const t = (req.headers.authorization || "").replace(/^Bearer /, "");
      const p = t && verificaToken(t, secret);
      const u = p && (await one("SELECT id, nome, papel FROM usuarios WHERE id = ?", p.id));
      if (!u) throw new Erro(401, "Faça login para continuar");
      return u;
    }
    const quemAceitou = async (p) =>
      p.orcamento_aceito == null ? null : (await one("SELECT pro_id FROM orcamentos WHERE id = ?", p.orcamento_aceito))?.pro_id;
    const participa = async (p, u) => (u.papel === "cliente" ? p.cliente_id === u.id : (await quemAceitou(p)) === u.id);

    async function carregaPedido(id, u) {
      const p = await one("SELECT * FROM pedidos WHERE id = ?", id);
      const visivel =
        p && (u.papel === "cliente" ? p.cliente_id === u.id : p.status === "aberto" || (await quemAceitou(p)) === u.id);
      if (!visivel) throw new Erro(404, "Pedido não encontrado");
      return p;
    }

    if (m === "POST" && path === "/api/registro") {
      limite(req);
      const b = await corpo(req);
      const nome = texto(b.nome, "Nome", 2, 80);
      const email = texto(b.email, "E-mail", 5, 120).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Erro(400, "E-mail inválido");
      const senha = texto(b.senha, "Senha", 6, 100);
      if (!["cliente", "profissional"].includes(b.papel)) throw new Erro(400, "Escolha cliente ou profissional");
      let id;
      try {
        id = await ins("INSERT INTO usuarios(nome,email,senha,papel) VALUES(?,?,?,?)", nome, email, hashSenha(senha), b.papel);
      } catch (e) {
        if (db.ehDuplicado(e)) throw new Erro(409, "Este e-mail já está cadastrado");
        throw e;
      }
      const usuario = { id, nome, papel: b.papel };
      return json(res, 201, { token: assinaToken(usuario, secret), usuario });
    }
    if (m === "POST" && path === "/api/login") {
      limite(req);
      const b = await corpo(req);
      const r = await one("SELECT * FROM usuarios WHERE email = ?", String(b.email || "").trim().toLowerCase());
      if (!r || !confereSenha(String(b.senha || ""), r.senha)) throw new Erro(401, "E-mail ou senha incorretos");
      const usuario = { id: r.id, nome: r.nome, papel: r.papel };
      return json(res, 200, { token: assinaToken(usuario, secret), usuario });
    }

    const u = await usuarioDoToken();
    if (m === "GET" && path === "/api/eu") return json(res, 200, u);

    if (m === "GET" && path === "/api/pedidos") {
      const linhas =
        u.papel === "cliente"
          ? await all("SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC", u.id)
          : await all(
              `SELECT * FROM pedidos WHERE status = 'aberto' OR orcamento_aceito IN (SELECT id FROM orcamentos WHERE pro_id = ?) ORDER BY id DESC`,
              u.id
            );
      const rep = new Map();
      return json(res, 200, await Promise.all(linhas.map((p) => fmt(p, u, rep))));
    }
    if (m === "POST" && path === "/api/pedidos") {
      exige(u, "cliente");
      const b = await corpo(req);
      const titulo = texto(b.titulo, "Título", 3, 80);
      if (!CATEGORIAS.includes(b.categoria)) throw new Erro(400, "Categoria inválida");
      const descricao = texto(b.descricao, "Descrição", 0, 400);
      const id = await ins("INSERT INTO pedidos(cliente_id,titulo,categoria,descricao) VALUES(?,?,?,?)", u.id, titulo, b.categoria, descricao);
      return json(res, 201, await fmt(await one("SELECT * FROM pedidos WHERE id = ?", id), u, new Map()));
    }

    const r = path.match(/^\/api\/pedidos\/(\d+)(?:\/(\w+))?$/);
    if (!r) throw new Erro(404, "Rota não encontrada");
    const p = await carregaPedido(Number(r[1]), u);
    const acao = r[2];
    const devolve = async () => json(res, 200, await fmt(await one("SELECT * FROM pedidos WHERE id = ?", p.id), u, new Map()));

    if (m === "GET" && !acao) return devolve();
    if (m !== "POST") throw new Erro(404, "Rota não encontrada");
    const b = await corpo(req);

    if (acao === "orcamentos") {
      exige(u, "profissional");
      if (p.status !== "aberto") throw new Erro(409, "Este pedido não recebe mais orçamentos");
      const valor = Math.round(Number(b.valor) * 100);
      if (!(valor > 0) || valor > 100000000) throw new Erro(400, "Informe um valor válido");
      const prazo = texto(b.prazo || "A combinar", "Prazo", 1, 30);
      const mensagem = texto(b.mensagem, "Mensagem", 0, 300);
      try {
        await run("INSERT INTO orcamentos(pedido_id,pro_id,valor,prazo,mensagem) VALUES(?,?,?,?,?)", p.id, u.id, valor, prazo, mensagem);
      } catch (e) {
        if (db.ehDuplicado(e)) throw new Erro(409, "Você já enviou orçamento para este pedido");
        throw e;
      }
      return devolve();
    }
    if (acao === "aceitar") {
      exige(u, "cliente");
      if (p.status !== "aberto") throw new Erro(409, "Este pedido já tem orçamento aceito");
      const o = await one("SELECT * FROM orcamentos WHERE id = ? AND pedido_id = ?", Number(b.orcamentoId), p.id);
      if (!o) throw new Erro(400, "Orçamento inválido");
      const taxa = Math.round(o.valor * TAXA);
      const total = o.valor + taxa;
      const ret = await pagamentos.reter({ pedidoId: p.id, totalCentavos: total });
      try {
        await tx(async (t) => {
          await t.run(
            "INSERT INTO pagamentos(pedido_id,orcamento_id,valor,taxa,total,status,ref) VALUES(?,?,?,?,?,?,?)",
            p.id, o.id, o.valor, taxa, total, "retido", ret.ref
          );
          await t.run("UPDATE pedidos SET status = 'and', orcamento_aceito = ? WHERE id = ?", o.id, p.id);
        });
      } catch (e) {
        if (db.ehDuplicado(e)) throw new Erro(409, "Este pedido já tem orçamento aceito");
        throw e;
      }
      return devolve();
    }
    if (acao === "concluir") {
      exige(u, "profissional");
      if ((await quemAceitou(p)) !== u.id || p.status !== "and") throw new Erro(409, "Ação indisponível");
      await run("UPDATE pedidos SET concluido = 1 WHERE id = ?", p.id);
      return devolve();
    }
    if (acao === "confirmar") {
      exige(u, "cliente");
      if (p.status !== "and" || !p.concluido) throw new Erro(409, "O profissional ainda não marcou como concluído");
      const pg = await one("SELECT * FROM pagamentos WHERE pedido_id = ?", p.id);
      await pagamentos.liberar({ ref: pg.ref });
      await tx(async (t) => {
        await t.run("UPDATE pagamentos SET status = 'liberado' WHERE id = ?", pg.id);
        await t.run("UPDATE pedidos SET status = 'fin' WHERE id = ?", p.id);
      });
      return devolve();
    }
    if (acao === "disputa") {
      if (p.status !== "and" || !(await participa(p, u))) throw new Erro(409, "Ação indisponível");
      await tx(async (t) => {
        await t.run("UPDATE pedidos SET status = 'dis' WHERE id = ?", p.id);
        await t.run("UPDATE pagamentos SET status = 'em_disputa' WHERE pedido_id = ?", p.id);
      });
      return devolve();
    }
    if (acao === "mensagens") {
      if (p.orcamento_aceito == null || !(await participa(p, u))) throw new Erro(403, "Chat disponível após o orçamento ser aceito");
      await run("INSERT INTO mensagens(pedido_id,papel,texto) VALUES(?,?,?)", p.id, u.papel, texto(b.texto, "Mensagem", 1, 300));
      return devolve();
    }
    if (acao === "avaliar") {
      exige(u, "cliente");
      const nota = Number(b.nota);
      if (p.status !== "fin" || p.nota) throw new Erro(409, "Avaliação indisponível");
      if (!Number.isInteger(nota) || nota < 1 || nota > 5) throw new Erro(400, "Nota de 1 a 5");
      await run("UPDATE pedidos SET nota = ?, comentario = ? WHERE id = ?", nota, texto(b.comentario, "Comentário", 0, 200), p.id);
      return devolve();
    }
    throw new Erro(404, "Rota não encontrada");
  }

  return async function manipulador(req, res) {
    const path = new URL(req.url, "http://x").pathname;
    try {
      if (path === "/health") {
        // Verifica também a conexão com o banco, o que ajuda a achar erro de configuração.
        try {
          if (!secret) throw new Error("JWT_SECRET não configurada");
          await (await obterBanco()).one("SELECT 1 AS ok");
          return json(res, 200, { ok: true });
        } catch (e) {
          console.error("health:", e.message);
          return json(res, 503, { ok: false, erro: "Configuração incompleta: confira JWT_SECRET e DATABASE_URL" });
        }
      }
      if (!secret) throw new Erro(500, "Servidor sem JWT_SECRET configurada");
      if (path.startsWith("/api/")) return await api(req, res, path);
      throw new Erro(404, "Rota não encontrada");
    } catch (e) {
      if (e instanceof Erro) return json(res, e.status, { erro: e.message });
      console.error(e);
      return json(res, 500, { erro: "Erro interno" });
    }
  };
}
