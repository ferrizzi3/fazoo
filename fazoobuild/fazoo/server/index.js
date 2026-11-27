import { hashSenha, confereSenha, assinaToken, verificaToken } from "./auth.js";
import { pagamentos } from "./payments.js";
import { criaArmazenamento } from "./armazenamento.js";
import { cidade, nomeCidade, distanciaKm, dentroDoRaio, RAIOS } from "./cidades.js";
import { randomBytes } from "node:crypto";

const CATEGORIAS = ["Ar-condicionado", "Reparo elétrico", "Encanamento", "Construção civil", "Pintura"];
const TAXA = 0.1; // 10% pagos pelo cliente por cima do orçamento

// Anexos do pedido. Limites pensados para gastar pouco espaço no Blob:
// fotos são reduzidas no celular antes do envio e o áudio é gravado em qualidade de voz.
const MB = 1024 * 1024;
export const ANEXOS = {
  foto: { qtd: 30, max: 3 * MB, mimes: ["image/jpeg", "image/png", "image/webp"] },
  video: { qtd: 2, max: 30 * MB, dur: 60, mimes: ["video/mp4", "video/quicktime", "video/webm"] },
  audio: { qtd: 3, max: 3 * MB, dur: 180, mimes: ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac"] },
};
const EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac",
};

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

// Lê o código IBGE da cidade enviado pelo app. Vazio -> undefined; inválido -> erro.
function cidadeInformada(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const c = cidade(v);
  if (!c) throw new Erro(400, "Escolha a cidade na lista");
  return c.id;
}
const usuarioPublico = (r) => ({ id: r.id, nome: r.nome, papel: r.papel, cidade: cidade(r.cidade_id) });

const iniciais = (nome) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");

// "Ana Maria Souza" -> "Ana S." (usado para mostrar clientes sem expor o nome completo)
const nomeCurto = (n) => {
  const ps = String(n).split(/\s+/).filter(Boolean);
  return ps.length > 1 ? `${ps[0]} ${ps[ps.length - 1][0].toUpperCase()}.` : ps[0];
};

// O Postgres devolve Date; o SQLite devolve texto "AAAA-MM-DD HH:MM:SS" em UTC.
const dataIso = (v) => {
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T") + (/[zZ+]/.test(String(v)) ? "" : "Z"));
  return isNaN(d) ? null : d.toISOString();
};

const exige = (u, papel) => {
  if (u.papel !== papel) throw new Erro(403, "Ação não permitida para o seu tipo de conta");
};

// Retorna uma função (req, res) para servidor Node comum ou função da Vercel.
export function criaManipulador({ obterBanco, secret, armazenamento }) {
  const arm = armazenamento !== undefined ? armazenamento : criaArmazenamento({ secret });
  const semArm = () => {
    if (!arm) throw new Erro(503, "Anexos indisponíveis: conecte um Blob store ao projeto na Vercel");
    return arm;
  };
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

    async function resumoCliente(id) {
      const c = await one(`SELECT nome, cidade_id FROM usuarios WHERE id = ?`, id);
      const r = await one(
        `SELECT COUNT(a.nota) AS na, AVG(a.nota) AS m FROM avaliacoes_cliente a JOIN pedidos p ON p.id = a.pedido_id WHERE p.cliente_id = ?`,
        id
      );
      const na = Number(r.na);
      return {
        id,
        nome: nomeCurto(c.nome),
        i: iniciais(nomeCurto(c.nome)),
        cidade: nomeCidade(c.cidade_id),
        n: na ? `${Number(r.m).toFixed(1).replace(".", ",")} · ${na} avaliaç${na > 1 ? "ões" : "ão"}` : "Sem avaliações ainda",
      };
    }

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

    // Perfil que qualquer usuário logado pode ver: dados, estatísticas e avaliações.
    // Do cliente que avaliou só aparece o primeiro nome e a inicial do sobrenome.
    async function perfilPublico(id) {
      const pro = await one(
        `SELECT u.id, u.nome, u.criado, u.cidade_id, pf.bio, pf.cidade, pf.categorias
         FROM usuarios u LEFT JOIN perfis pf ON pf.usuario_id = u.id WHERE u.id = ? AND u.papel = 'profissional'`,
        id
      );
      if (!pro) return null;
      const est = await one(
        `SELECT COUNT(*) AS c, COUNT(p.nota) AS na, AVG(p.nota) AS m
         FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_aceito WHERE o.pro_id = ? AND p.status = 'fin'`,
        id
      );
      const avs = await all(
        `SELECT p.nota, p.comentario, p.categoria, p.criado, c.nome
         FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_aceito JOIN usuarios c ON c.id = p.cliente_id
         WHERE o.pro_id = ? AND p.status = 'fin' AND p.nota IS NOT NULL ORDER BY p.id DESC LIMIT 30`,
        id
      );
      return {
        id: pro.id,
        nome: pro.nome,
        i: iniciais(pro.nome),
        bio: pro.bio || "",
        cidade: nomeCidade(pro.cidade_id) || pro.cidade || "",
        cidadeId: pro.cidade_id ?? null,
        dist: distanciaKm(refCidade, pro.cidade_id),
        categorias: pro.categorias ? pro.categorias.split("|") : [],
        desde: dataIso(pro.criado),
        servicos: Number(est.c),
        avaliacoes: Number(est.na),
        media: est.m == null ? null : Math.round(Number(est.m) * 10) / 10,
        lista: avs.map((a) => ({
          nota: Number(a.nota),
          comentario: a.comentario || "",
          categoria: a.categoria,
          cliente: nomeCurto(a.nome),
          data: dataIso(a.criado),
        })),
      };
    }

    // Perfil básico do cliente: nome curto, cidade, data de cadastro e avaliações feitas pelos profissionais.
    async function perfilCliente(id) {
      const c = await one(
        `SELECT u.id, u.nome, u.criado, u.cidade_id, pf.cidade FROM usuarios u LEFT JOIN perfis pf ON pf.usuario_id = u.id
         WHERE u.id = ? AND u.papel = 'cliente'`,
        id
      );
      if (!c) return null;
      const est = await one(
        `SELECT COUNT(*) AS c, COUNT(a.nota) AS na, AVG(a.nota) AS m
         FROM pedidos p LEFT JOIN avaliacoes_cliente a ON a.pedido_id = p.id WHERE p.cliente_id = ? AND p.status = 'fin'`,
        id
      );
      const avs = await all(
        `SELECT a.nota, a.comentario, p.categoria, p.criado, us.nome
         FROM avaliacoes_cliente a JOIN pedidos p ON p.id = a.pedido_id
         JOIN orcamentos o ON o.id = p.orcamento_aceito JOIN usuarios us ON us.id = o.pro_id
         WHERE p.cliente_id = ? ORDER BY p.id DESC LIMIT 30`,
        id
      );
      return {
        id: c.id,
        tipo: "cliente",
        nome: nomeCurto(c.nome),
        i: iniciais(nomeCurto(c.nome)),
        cidade: nomeCidade(c.cidade_id) || c.cidade || "",
        cidadeId: c.cidade_id ?? null,
        desde: dataIso(c.criado),
        servicos: Number(est.c),
        avaliacoes: Number(est.na),
        media: est.m == null ? null : Math.round(Number(est.m) * 10) / 10,
        lista: avs.map((a) => ({
          nota: Number(a.nota),
          comentario: a.comentario || "",
          categoria: a.categoria,
          autor: a.nome,
          data: dataIso(a.criado),
        })),
      };
    }
    // Profissional só vê o cliente que tem pedido aberto ou que contratou ele.
    async function podeVerCliente(u, id) {
      if (u.papel === "cliente") return u.id === id;
      const r = await one(
        `SELECT 1 AS ok FROM pedidos WHERE cliente_id = ? AND (status = 'aberto' OR orcamento_aceito IN (SELECT id FROM orcamentos WHERE pro_id = ?))`,
        id, u.id
      );
      return !!r;
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
          pid: o.pro_id,
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
      let avc = null;
      if (p.status === "fin") {
        const a = await one(`SELECT nota, comentario FROM avaliacoes_cliente WHERE pedido_id = ?`, p.id);
        if (a) avc = { nota: Number(a.nota), comentario: a.comentario || "" };
      }
      const ed = await one(`SELECT quando FROM pedidos_edicoes WHERE pedido_id = ?`, p.id);
      const anx = { n: 0, apagados: 0 };
      for (const r of await all(`SELECT status, COUNT(*) AS c FROM anexos WHERE pedido_id = ? GROUP BY status`, p.id)) {
        if (r.status === "ok") anx.n = Number(r.c);
        if (r.status === "apagado") anx.apagados = Number(r.c);
      }
      let cli = null;
      if (u.papel === "profissional") {
        if (!rep.has("c" + p.cliente_id)) rep.set("c" + p.cliente_id, resumoCliente(p.cliente_id));
        cli = await rep.get("c" + p.cliente_id);
      }
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
        anx,
        loc: { cidade: nomeCidade(p.cidade_id), cidadeId: p.cidade_id ?? null, raio: p.raio_km ?? null, dist: distanciaKm(p.cidade_id, refCidade) },
        ed: ed ? dataIso(ed.quando) : null,
        avc: u.papel === "profissional" || p.status === "fin" ? avc : null,
        cli,
      };
    }

    // Serviço concluído: apaga fotos, vídeos e áudios do Blob para liberar espaço.
    // Se falhar, o pedido segue concluído e o prazo automático do Blob apaga depois.
    async function apagaAnexos(pedidoId) {
      const lista = await all(`SELECT id, caminho FROM anexos WHERE pedido_id = ? AND status <> 'apagado'`, pedidoId);
      if (!lista.length || !arm) return;
      try {
        await arm.apagar(lista.map((x) => x.caminho).filter(Boolean));
        await run(`UPDATE anexos SET status = 'apagado' WHERE pedido_id = ?`, pedidoId);
      } catch (e) {
        console.error("Falha ao apagar anexos do pedido", pedidoId, e.message);
      }
    }

    async function usuarioDoToken() {
      const t = (req.headers.authorization || "").replace(/^Bearer /, "");
      const p = t && verificaToken(t, secret);
      const u = p && (await one("SELECT id, nome, papel, cidade_id FROM usuarios WHERE id = ?", p.id));
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
      const cidadeId = cidadeInformada(b.cidade) ?? null;
      let id;
      try {
        id = await ins("INSERT INTO usuarios(nome,email,senha,papel,cidade_id) VALUES(?,?,?,?,?)", nome, email, hashSenha(senha), b.papel, cidadeId);
      } catch (e) {
        if (db.ehDuplicado(e)) throw new Erro(409, "Este e-mail já está cadastrado");
        throw e;
      }
      const usuario = usuarioPublico({ id, nome, papel: b.papel, cidade_id: cidadeId });
      return json(res, 201, { token: assinaToken({ id, nome, papel: b.papel }, secret), usuario });
    }
    if (m === "POST" && path === "/api/login") {
      limite(req);
      const b = await corpo(req);
      const r = await one("SELECT * FROM usuarios WHERE email = ?", String(b.email || "").trim().toLowerCase());
      if (!r || !confereSenha(String(b.senha || ""), r.senha)) throw new Erro(401, "E-mail ou senha incorretos");
      return json(res, 200, { token: assinaToken({ id: r.id, nome: r.nome, papel: r.papel }, secret), usuario: usuarioPublico(r) });
    }

    const u = await usuarioDoToken();
    if (m === "GET" && path === "/api/eu") return json(res, 200, usuarioPublico(u));
    const q = new URL(req.url, "http://x").searchParams;
    // cidade de referência para os filtros: a escolhida no topo do app ou a do perfil
    const refCidade = cidadeInformada(q.get("cidade")) ?? u.cidade_id;

    // ---- Encontrar profissionais por cidade, raio e categoria ----
    if (m === "GET" && path === "/api/profissionais") {
      if (!refCidade) throw new Erro(400, "Escolha uma cidade");
      const raio = RAIOS.includes(Number(q.get("raio"))) ? Number(q.get("raio")) : 25;
      const cat = q.get("categoria") || "";
      const pros = await all(
        `SELECT u.id, u.nome, u.cidade_id, pf.categorias FROM usuarios u LEFT JOIN perfis pf ON pf.usuario_id = u.id
         WHERE u.papel = 'profissional' AND u.cidade_id IS NOT NULL`
      );
      const perto = pros
        .map((x) => ({ ...x, dist: distanciaKm(refCidade, x.cidade_id) }))
        .filter((x) => x.dist != null && x.dist <= raio && (!cat || String(x.categorias || "").split("|").includes(cat)));
      const lista = await Promise.all(
        perto.slice(0, 200).map(async (x) => {
          const est = await one(
            `SELECT COUNT(*) AS c, COUNT(p.nota) AS na, AVG(p.nota) AS m FROM pedidos p JOIN orcamentos o ON o.id = p.orcamento_aceito
             WHERE o.pro_id = ? AND p.status = 'fin'`,
            x.id
          );
          return {
            id: x.id, nome: x.nome, i: iniciais(x.nome), cidade: nomeCidade(x.cidade_id), dist: x.dist,
            categorias: x.categorias ? x.categorias.split("|") : [],
            servicos: Number(est.c), avaliacoes: Number(est.na), media: est.m == null ? null : Math.round(Number(est.m) * 10) / 10,
          };
        })
      );
      lista.sort((a, b) => a.dist - b.dist || (b.media ?? 0) - (a.media ?? 0) || b.servicos - a.servicos);
      return json(res, 200, { cidade: cidade(refCidade), raio, total: lista.length, profissionais: lista });
    }


    // ---- Perfil do profissional ----
    // Configurações comuns aos dois tipos de conta: nome e cidade.
    async function salvaBasico(b) {
      if (b.nome !== undefined) await run("UPDATE usuarios SET nome = ? WHERE id = ?", texto(b.nome, "Nome", 2, 80), u.id);
      const c = cidadeInformada(b.cidade);
      if (c !== undefined) await run("UPDATE usuarios SET cidade_id = ? WHERE id = ?", c, u.id);
    }
    if (m === "POST" && path === "/api/perfil" && u.papel === "cliente") {
      await salvaBasico(await corpo(req));
      return json(res, 200, await perfilCliente(u.id));
    }
    if (m === "GET" && path === "/api/perfil" && u.papel === "cliente") return json(res, 200, await perfilCliente(u.id));
    if (m === "POST" && path === "/api/perfil") {
      exige(u, "profissional");
      const b = await corpo(req);
      await salvaBasico(b);
      const bio = texto(b.bio, "Sobre você", 0, 500);
      const cidadeTxt = "";
      const cats = Array.isArray(b.categorias) ? [...new Set(b.categorias)] : [];
      if (cats.some((c) => !CATEGORIAS.includes(c))) throw new Erro(400, "Categoria inválida");
      await run(
        `INSERT INTO perfis(usuario_id,bio,cidade,categorias) VALUES(?,?,?,?)
         ON CONFLICT(usuario_id) DO UPDATE SET bio = excluded.bio, cidade = excluded.cidade, categorias = excluded.categorias`,
        u.id, bio, cidadeTxt, cats.join("|")
      );
      return json(res, 200, await perfilPublico(u.id));
    }
    if (m === "GET" && path === "/api/perfil") {
      exige(u, "profissional");
      return json(res, 200, await perfilPublico(u.id));
    }
    const rc = path.match(/^\/api\/clientes\/(\d+)$/);
    if (m === "GET" && rc) {
      const id = Number(rc[1]);
      const perfil = (await podeVerCliente(u, id)) && (await perfilCliente(id));
      if (!perfil) throw new Erro(404, "Cliente não encontrado");
      return json(res, 200, perfil);
    }
    const rp = path.match(/^\/api\/profissionais\/(\d+)$/);
    if (m === "GET" && rp) {
      const perfil = await perfilPublico(Number(rp[1]));
      if (!perfil) throw new Erro(404, "Profissional não encontrado");
      return json(res, 200, perfil);
    }

    if (m === "GET" && path === "/api/pedidos") {
      const linhas =
        u.papel === "cliente"
          ? await all("SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC", u.id)
          : await all(
              `SELECT * FROM pedidos WHERE status = 'aberto' OR orcamento_aceito IN (SELECT id FROM orcamentos WHERE pro_id = ?) ORDER BY id DESC`,
              u.id
            );
      // Profissional: pedidos novos só aparecem se o alcance escolhido pelo cliente chega à cidade de referência.
      const visiveis =
        u.papel === "profissional" && refCidade
          ? (
              await Promise.all(
                linhas.map(async (p) =>
                  p.status !== "aberto" || dentroDoRaio(p.cidade_id, p.raio_km, refCidade) ||
                  (await one("SELECT 1 AS ok FROM orcamentos WHERE pedido_id = ? AND pro_id = ?", p.id, u.id))
                    ? p
                    : null
                )
              )
            ).filter(Boolean)
          : linhas;
      const rep = new Map();
      return json(res, 200, await Promise.all(visiveis.map((p) => fmt(p, u, rep))));
    }
    if (m === "POST" && path === "/api/pedidos") {
      exige(u, "cliente");
      const b = await corpo(req);
      const titulo = texto(b.titulo, "Título", 3, 80);
      if (!CATEGORIAS.includes(b.categoria)) throw new Erro(400, "Categoria inválida");
      const descricao = texto(b.descricao, "Descrição", 0, 400);
      const cidadeId = cidadeInformada(b.cidade) ?? u.cidade_id ?? null;
      const raio = RAIOS.includes(Number(b.raio)) ? Number(b.raio) : 25;
      const id = await ins(
        "INSERT INTO pedidos(cliente_id,titulo,categoria,descricao,cidade_id,raio_km) VALUES(?,?,?,?,?,?)",
        u.id, titulo, b.categoria, descricao, cidadeId, cidadeId ? raio : null
      );
      return json(res, 201, await fmt(await one("SELECT * FROM pedidos WHERE id = ?", id), u, new Map()));
    }

    // ---- Anexos (fotos, vídeos e áudios) ----
    const ra = path.match(/^\/api\/pedidos\/(\d+)\/anexos(?:\/(\d+)\/(ok|apagar))?$/);
    if (ra) {
      const p = await carregaPedido(Number(ra[1]), u);
      if (m === "GET" && !ra[2]) {
        const lista = await all(`SELECT id, tipo, mime, tamanho, duracao, caminho FROM anexos WHERE pedido_id = ? AND status = 'ok' ORDER BY id`, p.id);
        const a = lista.length ? semArm() : null;
        return json(res, 200, {
          anexos: await Promise.all(
            lista.map(async (x) => ({ id: x.id, tipo: x.tipo, mime: x.mime, tamanho: Number(x.tamanho), duracao: Number(x.duracao), url: await a.urlLeitura(x.caminho) }))
          ),
        });
      }
      if (m !== "POST") throw new Erro(404, "Rota não encontrada");
      exige(u, "cliente");
      if (p.status !== "aberto") throw new Erro(409, "Só dá para mexer nos anexos enquanto o pedido recebe orçamentos");
      const a = semArm();
      const b = await corpo(req);
      if (!ra[2]) {
        const cfg = ANEXOS[b.tipo];
        if (!cfg) throw new Erro(400, "Tipo de anexo inválido");
        const mime = String(b.mime || "").split(";")[0].trim().toLowerCase();
        if (!cfg.mimes.includes(mime)) throw new Erro(400, "Formato de arquivo não aceito");
        const tamanho = Math.round(Number(b.tamanho));
        if (!(tamanho > 0)) throw new Erro(400, "Arquivo vazio");
        if (tamanho > cfg.max) throw new Erro(400, `Arquivo grande demais (máximo ${cfg.max / MB} MB)`);
        const duracao = Math.max(0, Math.round(Number(b.duracao) || 0));
        if (cfg.dur && duracao > cfg.dur) throw new Erro(400, `Duração máxima: ${cfg.dur} segundos`);
        const cont = await one(
          `SELECT COUNT(*) AS c, SUM(CASE WHEN status = 'ok' AND tipo = ? THEN 1 ELSE 0 END) AS t FROM anexos WHERE pedido_id = ? AND status <> 'apagado'`,
          b.tipo, p.id
        );
        if (Number(cont.t || 0) >= cfg.qtd) throw new Erro(409, `Limite de ${cfg.qtd} ${b.tipo === "foto" ? "fotos" : b.tipo === "video" ? "vídeos" : "áudios"} por pedido`);
        if (Number(cont.c) >= 60) throw new Erro(409, "Limite de anexos atingido");
        const id = await ins("INSERT INTO anexos(pedido_id,tipo,mime,tamanho,duracao) VALUES(?,?,?,?,?)", p.id, b.tipo, mime, tamanho, duracao);
        // Nome difícil de adivinhar; a pasta por pedido facilita conferir e apagar.
        const caminho = `pedidos/${p.id}/${id}-${randomBytes(9).toString("base64url")}.${EXT[mime]}`;
        await run("UPDATE anexos SET caminho = ? WHERE id = ?", caminho, id);
        return json(res, 201, { id, mime, url: await a.urlEnvio({ caminho, mime, max: cfg.max }) });
      }
      const x = await one("SELECT * FROM anexos WHERE id = ? AND pedido_id = ?", Number(ra[2]), p.id);
      if (!x || x.status === "apagado") throw new Erro(404, "Anexo não encontrado");
      if (ra[3] === "ok") {
        if (x.status !== "enviando") return json(res, 200, { ok: true });
        const t = await a.tamanho(x.caminho);
        if (t == null) throw new Erro(409, "O arquivo ainda não chegou. Tente enviar de novo.");
        if (t > ANEXOS[x.tipo].max) {
          await a.apagar([x.caminho]);
          await run("UPDATE anexos SET status = 'apagado' WHERE id = ?", x.id);
          throw new Erro(400, "Arquivo grande demais");
        }
        await run("UPDATE anexos SET status = 'ok', tamanho = ? WHERE id = ?", t, x.id);
        return json(res, 200, { ok: true });
      }
      await a.apagar([x.caminho]);
      await run("UPDATE anexos SET status = 'apagado' WHERE id = ?", x.id);
      return json(res, 200, { ok: true });
    }

    const r = path.match(/^\/api\/pedidos\/(\d+)(?:\/([\w-]+))?$/);
    if (!r) throw new Erro(404, "Rota não encontrada");
    const p = await carregaPedido(Number(r[1]), u);
    const acao = r[2];
    const devolve = async () => json(res, 200, await fmt(await one("SELECT * FROM pedidos WHERE id = ?", p.id), u, new Map()));

    if (m === "GET" && !acao) return devolve();
    if (m !== "POST") throw new Erro(404, "Rota não encontrada");
    const b = await corpo(req);

    if (acao === "editar") {
      exige(u, "cliente");
      if (p.status !== "aberto") throw new Erro(409, "Só dá para editar o pedido enquanto ele recebe orçamentos");
      const titulo = texto(b.titulo, "Título", 3, 80);
      if (!CATEGORIAS.includes(b.categoria)) throw new Erro(400, "Categoria inválida");
      const descricao = texto(b.descricao, "Descrição", 0, 400);
      await run("UPDATE pedidos SET titulo = ?, categoria = ?, descricao = ? WHERE id = ?", titulo, b.categoria, descricao, p.id);
      const novaCidade = cidadeInformada(b.cidade);
      if (novaCidade !== undefined) await run("UPDATE pedidos SET cidade_id = ? WHERE id = ?", novaCidade, p.id);
      if (b.raio !== undefined && RAIOS.includes(Number(b.raio))) await run("UPDATE pedidos SET raio_km = ? WHERE id = ?", Number(b.raio), p.id);
      // guarda que o pedido mudou depois de publicado (o profissional vê o aviso "Editado")
      await run(
        `INSERT INTO pedidos_edicoes(pedido_id) VALUES(?)
         ON CONFLICT(pedido_id) DO UPDATE SET vezes = pedidos_edicoes.vezes + 1, quando = CURRENT_TIMESTAMP`,
        p.id
      );
      return devolve();
    }
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
      await apagaAnexos(p.id);
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
    if (acao === "avaliar-cliente") {
      exige(u, "profissional");
      if (p.status !== "fin" || (await quemAceitou(p)) !== u.id) throw new Erro(409, "Avaliação indisponível");
      const nota = Number(b.nota);
      if (!Number.isInteger(nota) || nota < 1 || nota > 5) throw new Erro(400, "Nota de 1 a 5");
      try {
        await run("INSERT INTO avaliacoes_cliente(pedido_id,nota,comentario) VALUES(?,?,?)", p.id, nota, texto(b.comentario, "Comentário", 0, 200));
      } catch (e) {
        if (db.ehDuplicado(e)) throw new Erro(409, "Você já avaliou este cliente");
        throw e;
      }
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
      if (path.startsWith("/api/arquivos/") && arm?.modo === "local") return await arm.atende(req, res, new URL(req.url, "http://x"));
      if (path.startsWith("/api/")) return await api(req, res, path);
      throw new Erro(404, "Rota não encontrada");
    } catch (e) {
      if (e instanceof Erro) return json(res, e.status, { erro: e.message });
      console.error(e);
      return json(res, 500, { erro: "Erro interno" });
    }
  };
}
