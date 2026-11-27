import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { criaManipulador } from "../server/index.js";
import { abreBanco, converteParametros, schemaPostgres } from "../server/db.js";
import { criaArmazenamento } from "../server/armazenamento.js";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function sobe() {
  const banco = abreBanco({ arquivo: ":memory:" });
  const pasta = mkdtempSync(join(tmpdir(), "fazoo-anexos-"));
  const armazenamento = criaArmazenamento({ secret: "teste", pasta });
  const srv = http.createServer(criaManipulador({ obterBanco: () => banco, secret: "teste", armazenamento }));
  await new Promise((r) => srv.listen(0, r));
  const base = "http://127.0.0.1:" + srv.address().port;
  const call = async (m, p, b, tok) => {
    const r = await fetch(base + p, {
      method: m,
      headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { s: r.status, j: await r.json() };
  };
  const fecha = async () => {
    srv.close();
    await (await banco).fechar();
  };
  return { call, fecha, base, pasta };
}
const conta = async (call, nome, email, papel) => (await call("POST", "/api/registro", { nome, email, senha: "123456", papel })).j.token;

test("fluxo completo: pedido, orçamento, pagamento retido, conclusão e avaliação", async (t) => {
  const { call, fecha } = await sobe();
  t.after(fecha);

  assert.equal((await call("GET", "/health")).s, 200);

  const c = await call("POST", "/api/registro", { nome: "Ana Souza", email: "ana@x.com", senha: "123456", papel: "cliente" });
  const pr = await call("POST", "/api/registro", { nome: "João Ribeiro", email: "joao@x.com", senha: "123456", papel: "profissional" });
  assert.equal(c.s, 201);
  assert.equal(pr.s, 201);
  const tc = c.j.token, tp = pr.j.token;

  assert.equal((await call("POST", "/api/registro", { nome: "Ana", email: "ana@x.com", senha: "123456", papel: "cliente" })).s, 409);
  assert.equal((await call("POST", "/api/login", { email: "ana@x.com", senha: "errada" })).s, 401);
  assert.equal((await call("POST", "/api/login", { email: "ana@x.com", senha: "123456" })).s, 200);
  assert.equal((await call("GET", "/api/pedidos")).s, 401);

  const ped = await call("POST", "/api/pedidos", { titulo: "Instalar ar-condicionado", categoria: "Ar-condicionado", descricao: "Sala" }, tc);
  assert.equal(ped.s, 201);
  const id = ped.j.id;
  assert.equal((await call("POST", "/api/pedidos", { titulo: "xxx", categoria: "Pintura" }, tp)).s, 403);

  const lista = await call("GET", "/api/pedidos", null, tp);
  assert.equal(lista.j.length, 1);
  assert.equal(lista.j[0].jaOrcou, false);

  assert.equal((await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 3000, prazo: "2 dias", mensagem: "ok" }, tc)).s, 403);
  assert.equal((await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 3000, prazo: "2 dias", mensagem: "ok" }, tp)).s, 200);
  assert.equal((await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 100 }, tp)).s, 409);

  const vis = await call("GET", `/api/pedidos/${id}`, null, tc);
  assert.equal(vis.j.orc.length, 1);
  assert.equal(vis.j.orc[0].v, 3000);

  const ac = await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: vis.j.orc[0].id }, tc);
  assert.equal(ac.j.st, "and");
  assert.equal(ac.j.pg.total, 3300);
  assert.equal(ac.j.pg.taxa, 300);
  assert.equal((await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: vis.j.orc[0].id }, tc)).s, 409);

  assert.equal((await call("POST", `/api/pedidos/${id}/confirmar`, {}, tc)).s, 409);
  assert.equal((await call("POST", `/api/pedidos/${id}/mensagens`, { texto: "Pode vir amanhã?" }, tc)).j.ch.length, 1);
  assert.equal((await call("POST", `/api/pedidos/${id}/concluir`, {}, tc)).s, 403);
  assert.equal((await call("POST", `/api/pedidos/${id}/concluir`, {}, tp)).j.cn, true);

  const fim = await call("POST", `/api/pedidos/${id}/confirmar`, {}, tc);
  assert.equal(fim.j.st, "fin");
  assert.equal(fim.j.pg.status, "liberado");
  assert.equal((await call("POST", `/api/pedidos/${id}/avaliar`, { nota: 5, comentario: "Ótimo" }, tc)).j.av, 5);

  const meu = await call("GET", "/api/pedidos", null, tp);
  assert.equal(meu.j[0].meu, true);
  assert.match(meu.j[0].orc[0].n, /5,0 · 1 serviço/);
});

test("privacidade: ninguém vê ou mexe no pedido dos outros", async (t) => {
  const { call, fecha } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Souza", "ana@x.com", "cliente");
  const bia = await conta(call, "Bia Lima", "bia@x.com", "cliente");
  const joao = await conta(call, "João Ribeiro", "joao@x.com", "profissional");
  const livia = await conta(call, "Lívia Nunes", "livia@x.com", "profissional");

  const id = (await call("POST", "/api/pedidos", { titulo: "Pintar sala", categoria: "Pintura", descricao: "" }, ana)).j.id;
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, bia)).s, 404);
  assert.equal((await call("GET", "/api/pedidos", null, bia)).j.length, 0);

  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 800, prazo: "1 dia" }, joao);
  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 700, prazo: "2 dias" }, livia);
  // um profissional não enxerga o orçamento do outro
  const doJoao = (await call("GET", `/api/pedidos/${id}`, null, joao)).j;
  assert.equal(doJoao.orc.length, 1);
  assert.equal(doJoao.norc, 2);
  assert.equal((await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: doJoao.orc[0].id }, bia)).s, 404);

  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: doJoao.orc[0].id }, ana);
  // após aceitar, o profissional que não foi escolhido perde acesso
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, livia)).s, 404);
  assert.equal((await call("POST", `/api/pedidos/${id}/mensagens`, { texto: "oi" }, livia)).s, 404);
  assert.equal((await call("POST", `/api/pedidos/${id}/disputa`, {}, livia)).s, 404);
  assert.equal((await call("POST", `/api/pedidos/${id}/disputa`, {}, joao)).j.st, "dis");
});

test("adaptador Postgres: parâmetros e schema", () => {
  assert.equal(converteParametros("SELECT * FROM t WHERE a = ? AND b = ?"), "SELECT * FROM t WHERE a = $1 AND b = $2");
  const s = schemaPostgres();
  assert.ok(s.includes("SERIAL PRIMARY KEY"));
  assert.ok(s.includes("TIMESTAMPTZ"));
  assert.ok(!s.includes("INTEGER PRIMARY KEY"));
});

test("perfil do profissional: edição, estatísticas e avaliações", async (t) => {
  const { call, fecha } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Maria Souza", "ana@x.com", "cliente");
  const r = await call("POST", "/api/registro", { nome: "João Ribeiro", email: "joao@x.com", senha: "123456", papel: "profissional" });
  const joao = r.j.token, joaoId = r.j.usuario.id;

  // perfil novo começa vazio
  const vazio = await call("GET", `/api/profissionais/${joaoId}`, null, ana);
  assert.equal(vazio.s, 200);
  assert.equal(vazio.j.servicos, 0);
  assert.equal(vazio.j.media, null);
  assert.deepEqual(vazio.j.categorias, []);
  assert.ok(vazio.j.desde);

  // cliente salva só a cidade: "sobre" e categorias são ignorados
  const pc = (await call("POST", "/api/perfil", { bio: "x", categorias: ["Pintura"], cidade: 3525904 }, ana)).j;
  assert.equal(pc.tipo, "cliente");
  assert.equal(pc.bio, undefined);
  assert.equal((await call("POST", "/api/perfil", { categorias: ["Jardinagem"] }, joao)).s, 400);
  const ed = await call("POST", "/api/perfil", { bio: "Eletricista há 10 anos", cidade: 3509502, categorias: ["Reparo elétrico", "Ar-condicionado"] }, joao);
  assert.equal(ed.s, 200);
  assert.equal(ed.j.cidade, "Campinas - SP");
  // editar de novo atualiza em vez de duplicar
  assert.equal((await call("POST", "/api/perfil", { bio: "Eletricista há 11 anos", cidade: 3509502, categorias: ["Reparo elétrico"] }, joao)).j.bio, "Eletricista há 11 anos");
  assert.deepEqual((await call("GET", "/api/perfil", null, joao)).j.categorias, ["Reparo elétrico"]);

  // cliente não tem perfil público e id inexistente dá 404
  assert.equal((await call("GET", `/api/profissionais/999`, null, ana)).s, 404);
  assert.equal((await call("GET", `/api/profissionais/1`, null, joao)).s, 404);

  // um serviço concluído e avaliado aparece no perfil
  const id = (await call("POST", "/api/pedidos", { titulo: "Trocar tomadas", categoria: "Reparo elétrico", descricao: "" }, ana)).j.id;
  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 200, prazo: "1 dia" }, joao);
  const ped = (await call("GET", `/api/pedidos/${id}`, null, ana)).j;
  assert.equal(ped.orc[0].pid, joaoId);
  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: ped.orc[0].id }, ana);
  await call("POST", `/api/pedidos/${id}/concluir`, {}, joao);
  await call("POST", `/api/pedidos/${id}/confirmar`, {}, ana);
  await call("POST", `/api/pedidos/${id}/avaliar`, { nota: 4, comentario: "Pontual" }, ana);

  const p = (await call("GET", `/api/profissionais/${joaoId}`, null, ana)).j;
  assert.equal(p.servicos, 1);
  assert.equal(p.avaliacoes, 1);
  assert.equal(p.media, 4);
  assert.equal(p.lista[0].cliente, "Ana S.");
  assert.equal(p.lista[0].comentario, "Pontual");
  assert.equal(p.lista[0].categoria, "Reparo elétrico");
  assert.equal(JSON.stringify(p).includes("ana@x.com"), false);
});

test("perfil do cliente: quem pode ver e avaliação feita pelo profissional", async (t) => {
  const { call, fecha } = await sobe();
  t.after(fecha);
  const ra = await call("POST", "/api/registro", { nome: "Ana Maria Souza", email: "ana@x.com", senha: "123456", papel: "cliente" });
  const ana = ra.j.token, anaId = ra.j.usuario.id;
  const bia = await conta(call, "Bia Lima", "bia@x.com", "cliente");
  const joao = await conta(call, "João Ribeiro", "joao@x.com", "profissional");
  const livia = await conta(call, "Lívia Nunes", "livia@x.com", "profissional");

  // cliente vê e edita o próprio perfil; outro cliente não vê
  assert.equal((await call("POST", "/api/perfil", { cidade: 3509502 }, ana)).j.cidade, "Campinas - SP");
  const meu = (await call("GET", "/api/perfil", null, ana)).j;
  assert.equal(meu.nome, "Ana S.");
  assert.equal(meu.tipo, "cliente");
  assert.equal((await call("GET", `/api/clientes/${anaId}`, null, ana)).s, 200);
  assert.equal((await call("GET", `/api/clientes/${anaId}`, null, bia)).s, 404);
  // profissional só vê cliente com pedido aberto
  assert.equal((await call("GET", `/api/clientes/${anaId}`, null, joao)).s, 404);

  const id = (await call("POST", "/api/pedidos", { titulo: "Trocar torneira", categoria: "Encanamento", descricao: "" }, ana)).j.id;
  const visto = (await call("GET", `/api/pedidos/${id}`, null, joao)).j;
  assert.equal(visto.cli.id, anaId);
  assert.equal(visto.cli.nome, "Ana S.");
  assert.equal((await call("GET", `/api/clientes/${anaId}`, null, joao)).s, 200);

  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 120, prazo: "1 dia" }, joao);
  const o = (await call("GET", `/api/pedidos/${id}`, null, ana)).j.orc[0];
  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: o.id }, ana);
  // depois de aceito, quem não foi escolhido perde acesso ao perfil
  assert.equal((await call("GET", `/api/clientes/${anaId}`, null, livia)).s, 404);
  // só avalia depois de concluído
  assert.equal((await call("POST", `/api/pedidos/${id}/avaliar-cliente`, { nota: 5 }, joao)).s, 409);
  await call("POST", `/api/pedidos/${id}/concluir`, {}, joao);
  await call("POST", `/api/pedidos/${id}/confirmar`, {}, ana);
  assert.equal((await call("POST", `/api/pedidos/${id}/avaliar-cliente`, { nota: 5 }, ana)).s, 403);
  const av = await call("POST", `/api/pedidos/${id}/avaliar-cliente`, { nota: 5, comentario: "Muito educada e pagou certinho" }, joao);
  assert.equal(av.s, 200);
  assert.equal(av.j.avc.nota, 5);
  assert.equal((await call("POST", `/api/pedidos/${id}/avaliar-cliente`, { nota: 1 }, joao)).s, 409);

  const p = (await call("GET", `/api/clientes/${anaId}`, null, joao)).j;
  assert.equal(p.servicos, 1);
  assert.equal(p.media, 5);
  assert.equal(p.lista[0].autor, "João Ribeiro");
  assert.equal(p.lista[0].comentario, "Muito educada e pagou certinho");
  assert.equal(JSON.stringify(p).includes("Maria"), false);
  assert.equal(JSON.stringify(p).includes("ana@x.com"), false);
});

test("anexos: envio, quem vê, limites e exclusão quando o serviço termina", async (t) => {
  const { call, fecha, base, pasta } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Souza", "ana@x.com", "cliente");
  const bia = await conta(call, "Bia Lima", "bia@x.com", "cliente");
  const joao = await conta(call, "João Ribeiro", "joao@x.com", "profissional");
  const livia = await conta(call, "Lívia Nunes", "livia@x.com", "profissional");
  const id = (await call("POST", "/api/pedidos", { titulo: "Infiltração no teto", categoria: "Construção civil", descricao: "Mancha no quarto" }, ana)).j.id;

  const foto = Buffer.from("imagem-de-teste-jpeg");
  const envia = async (tipo, mime, dados, extra = {}) => {
    const r = await call("POST", `/api/pedidos/${id}/anexos`, { tipo, mime, tamanho: dados.length, ...extra }, ana);
    if (r.s !== 201) return r;
    const put = await fetch(base + r.j.url, { method: "PUT", headers: { "Content-Type": r.j.mime }, body: dados });
    assert.equal(put.status, 200);
    return call("POST", `/api/pedidos/${id}/anexos/${r.j.id}/ok`, {}, ana);
  };

  assert.equal((await envia("foto", "image/jpeg", foto)).s, 200);
  assert.equal((await envia("audio", "audio/webm;codecs=opus", Buffer.from("audio"), { duracao: 12 })).s, 200);
  // regras
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "application/pdf", tamanho: 10 }, ana)).s, 400);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "video", mime: "video/mp4", tamanho: 40 * 1024 * 1024 }, ana)).s, 400);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "audio", mime: "audio/webm", tamanho: 10, duracao: 999 }, ana)).s, 400);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 10 }, joao)).s, 403);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 10 }, bia)).s, 404);
  // confirmar sem o arquivo ter chegado
  const sem = await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 10 }, ana);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos/${sem.j.id}/ok`, {}, ana)).s, 409);
  // link de envio não aceita outro tipo de arquivo
  assert.equal((await fetch(base + sem.j.url, { method: "PUT", headers: { "Content-Type": "text/html" }, body: "<b>x</b>" })).status, 400);

  // cliente e profissional veem; outro cliente não
  const lista = (await call("GET", `/api/pedidos/${id}/anexos`, null, joao)).j.anexos;
  assert.equal(lista.length, 2);
  assert.deepEqual(lista.map((x) => x.tipo), ["foto", "audio"]);
  assert.equal(lista[1].duracao, 12);
  const baixado = await fetch(base + lista[0].url);
  assert.equal(baixado.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await baixado.arrayBuffer()), foto);
  assert.equal((await call("GET", `/api/pedidos/${id}/anexos`, null, bia)).s, 404);
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, ana)).j.anx.n, 2);
  // link adulterado não abre
  assert.equal((await fetch(base + lista[0].url.replace(/s=[^&]+/, "s=xxx"))).status, 403);

  // serviço até o fim
  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 500, prazo: "1 dia" }, joao);
  const o = (await call("GET", `/api/pedidos/${id}`, null, ana)).j.orc[0];
  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: o.id }, ana);
  assert.equal((await call("GET", `/api/pedidos/${id}/anexos`, null, livia)).s, 404); // não escolhido perde acesso
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 10 }, ana)).s, 409);
  assert.equal((await call("GET", `/api/pedidos/${id}/anexos`, null, joao)).j.anexos.length, 2); // em andamento continua guardado
  await call("POST", `/api/pedidos/${id}/concluir`, {}, joao);
  const fim = await call("POST", `/api/pedidos/${id}/confirmar`, {}, ana);
  assert.deepEqual(fim.j.anx, { n: 0, apagados: 3 });
  assert.equal((await call("GET", `/api/pedidos/${id}/anexos`, null, ana)).j.anexos.length, 0);
  assert.equal((await fetch(base + lista[0].url)).status, 404);
  const sobrou = readdirSync(join(pasta, "pedidos", String(id))).filter((f) => !f.startsWith("."));
  assert.deepEqual(sobrou, []);
});

test("anexos: em disputa os arquivos ficam guardados", async (t) => {
  const { call, fecha, base } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Souza", "ana@x.com", "cliente");
  const joao = await conta(call, "João Ribeiro", "joao@x.com", "profissional");
  const id = (await call("POST", "/api/pedidos", { titulo: "Pintar muro", categoria: "Pintura", descricao: "" }, ana)).j.id;
  const r = await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/png", tamanho: 3 }, ana);
  await fetch(base + r.j.url, { method: "PUT", headers: { "Content-Type": "image/png" }, body: "png" });
  await call("POST", `/api/pedidos/${id}/anexos/${r.j.id}/ok`, {}, ana);
  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 300, prazo: "1 dia" }, joao);
  const o = (await call("GET", `/api/pedidos/${id}`, null, ana)).j.orc[0];
  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: o.id }, ana);
  assert.equal((await call("POST", `/api/pedidos/${id}/disputa`, {}, ana)).j.st, "dis");
  const l = (await call("GET", `/api/pedidos/${id}/anexos`, null, joao)).j.anexos;
  assert.equal(l.length, 1);
  assert.equal((await fetch(base + l[0].url)).status, 200);
});

test("anexos: aceita até 30 fotos por pedido", async (t) => {
  const { call, fecha, base } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Souza", "ana@x.com", "cliente");
  const id = (await call("POST", "/api/pedidos", { titulo: "Reforma do banheiro", categoria: "Construção civil", descricao: "" }, ana)).j.id;
  for (let i = 0; i < 30; i++) {
    const r = await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 3 }, ana);
    assert.equal(r.s, 201, "foto " + (i + 1));
    await fetch(base + r.j.url, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: "jpg" });
    await call("POST", `/api/pedidos/${id}/anexos/${r.j.id}/ok`, {}, ana);
  }
  const r31 = await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "foto", mime: "image/jpeg", tamanho: 3 }, ana);
  assert.equal(r31.s, 409);
  assert.match(r31.j.erro, /30 fotos/);
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, ana)).j.anx.n, 30);
});

test("editar pedido: texto e anexos enquanto recebe orçamentos", async (t) => {
  const { call, fecha, base } = await sobe();
  t.after(fecha);
  const ana = await conta(call, "Ana Souza", "ana@x.com", "cliente");
  const bia = await conta(call, "Bia Lima", "bia@x.com", "cliente");
  const joao = await conta(call, "João Ribeiro", "joao@x.com", "profissional");
  const id = (await call("POST", "/api/pedidos", { titulo: "Torneira pingando", categoria: "Encanamento", descricao: "" }, ana)).j.id;
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, ana)).j.ed, null);
  await call("POST", `/api/pedidos/${id}/orcamentos`, { valor: 100, prazo: "1 dia" }, joao);

  // só a dona do pedido edita
  assert.equal((await call("POST", `/api/pedidos/${id}/editar`, { titulo: "x", categoria: "Pintura" }, joao)).s, 403);
  assert.equal((await call("POST", `/api/pedidos/${id}/editar`, { titulo: "Outro", categoria: "Pintura" }, bia)).s, 404);
  assert.equal((await call("POST", `/api/pedidos/${id}/editar`, { titulo: "Torneira", categoria: "Jardim" }, ana)).s, 400);
  const ed = await call("POST", `/api/pedidos/${id}/editar`, { titulo: "Torneira e sifão pingando", categoria: "Encanamento", descricao: "Gravei um áudio explicando" }, ana);
  assert.equal(ed.s, 200);
  assert.equal(ed.j.t, "Torneira e sifão pingando");
  assert.ok(ed.j.ed);
  // o profissional vê a versão nova e o aviso de edição
  const vp = (await call("GET", `/api/pedidos/${id}`, null, joao)).j;
  assert.equal(vp.d, "Gravei um áudio explicando");
  assert.ok(vp.ed);
  // editar de novo funciona (atualiza o registro de edição)
  assert.equal((await call("POST", `/api/pedidos/${id}/editar`, { titulo: "Torneira e sifão", categoria: "Encanamento", descricao: "" }, ana)).s, 200);

  // depois de publicado ainda dá para adicionar e remover anexos
  const r = await call("POST", `/api/pedidos/${id}/anexos`, { tipo: "audio", mime: "audio/mp4", tamanho: 5, duracao: 20 }, ana);
  await fetch(base + r.j.url, { method: "PUT", headers: { "Content-Type": "audio/mp4" }, body: "audio" });
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos/${r.j.id}/ok`, {}, ana)).s, 200);
  assert.equal((await call("GET", `/api/pedidos/${id}`, null, ana)).j.anx.n, 1);
  assert.equal((await call("POST", `/api/pedidos/${id}/anexos/${r.j.id}/apagar`, {}, ana)).s, 200);
  assert.deepEqual((await call("GET", `/api/pedidos/${id}`, null, ana)).j.anx, { n: 0, apagados: 1 });

  // depois de aceitar um orçamento não dá mais para editar
  const o = (await call("GET", `/api/pedidos/${id}`, null, ana)).j.orc[0];
  await call("POST", `/api/pedidos/${id}/aceitar`, { orcamentoId: o.id }, ana);
  assert.equal((await call("POST", `/api/pedidos/${id}/editar`, { titulo: "Mudou", categoria: "Encanamento" }, ana)).s, 409);
});

// Códigos IBGE usados nos testes
const CAMPINAS = 3509502, SUMARE = 3552403, JUNDIAI = 3525904, SAO_PAULO = 3550308, RIO = 3304557;

test("cidades: cadastro, distância, raio do pedido e busca de profissionais", async (t) => {
  const { call, fecha } = await sobe();
  t.after(fecha);
  const reg = async (nome, email, papel, cidade) => (await call("POST", "/api/registro", { nome, email, senha: "123456", papel, cidade })).j;
  assert.equal((await call("POST", "/api/registro", { nome: "X", email: "x@x.com", senha: "123456", papel: "cliente", cidade: "Campinas" })).s, 400);
  const ana = await reg("Ana Souza", "ana@x.com", "cliente", CAMPINAS);
  assert.deepEqual(ana.usuario.cidade, { id: CAMPINAS, nome: "Campinas", uf: "SP" });
  assert.deepEqual((await call("GET", "/api/eu", null, ana.token)).j.cidade.nome, "Campinas");
  const joao = await reg("João Sumaré", "joao@x.com", "profissional", SUMARE); // ~18 km de Campinas
  const lia = await reg("Lia Jundiaí", "lia@x.com", "profissional", JUNDIAI); // ~37 km
  const rui = await reg("Rui Rio", "rui@x.com", "profissional", RIO); // ~400 km
  const bel = await reg("Bel Campinas", "bel@x.com", "profissional", CAMPINAS);
  await call("POST", "/api/perfil", { bio: "", categorias: ["Pintura"] }, bel.token);

  // busca de profissionais pela cidade escolhida no topo
  const busca = async (cidade, raio, categoria = "") =>
    (await call("GET", `/api/profissionais?cidade=${cidade}&raio=${raio}&categoria=${encodeURIComponent(categoria)}`, null, ana.token)).j;
  assert.deepEqual((await busca(CAMPINAS, 0)).profissionais.map((x) => x.nome), ["Bel Campinas"]);
  const r25 = await busca(CAMPINAS, 25);
  assert.deepEqual(r25.profissionais.map((x) => x.nome), ["Bel Campinas", "João Sumaré"]);
  assert.equal(r25.profissionais[1].cidade, "Sumaré - SP");
  assert.ok(r25.profissionais[1].dist > 10 && r25.profissionais[1].dist <= 25);
  assert.equal((await busca(CAMPINAS, 50)).total, 3);
  assert.deepEqual((await busca(CAMPINAS, 100, "Pintura")).profissionais.map((x) => x.nome), ["Bel Campinas"]);
  assert.equal((await busca(RIO, 10)).profissionais[0].nome, "Rui Rio");

  // pedido com alcance de 25 km: Sumaré vê, Jundiaí e Rio não
  const ped = (await call("POST", "/api/pedidos", { titulo: "Pintar sala", categoria: "Pintura", descricao: "", raio: 25 }, ana.token)).j;
  assert.deepEqual(ped.loc, { cidade: "Campinas - SP", cidadeId: CAMPINAS, raio: 25, dist: 0 });
  const vePedido = async (tok, cidade) => (await call("GET", "/api/pedidos" + (cidade ? `?cidade=${cidade}` : ""), null, tok)).j.length;
  assert.equal(await vePedido(joao.token), 1);
  assert.equal(await vePedido(bel.token), 1);
  assert.equal(await vePedido(lia.token), 0);
  assert.equal(await vePedido(rui.token), 0);
  // o profissional do Rio troca a cidade do topo para Campinas e passa a ver
  assert.equal(await vePedido(rui.token, CAMPINAS), 1);
  // depois de orçar, o pedido continua aparecendo para ele mesmo fora do raio
  await call("POST", `/api/pedidos/${ped.id}/orcamentos`, { valor: 300, prazo: "2 dias" }, rui.token);
  assert.equal(await vePedido(rui.token), 1);
  // a cliente aumenta o alcance para 50 km: Jundiaí passa a ver
  await call("POST", `/api/pedidos/${ped.id}/editar`, { titulo: "Pintar sala", categoria: "Pintura", descricao: "", raio: 50 }, ana.token);
  assert.equal(await vePedido(lia.token), 1);
  // pedido em outra cidade, só na mesma cidade (raio 0)
  await call("POST", "/api/pedidos", { titulo: "Trocar chuveiro", categoria: "Reparo elétrico", descricao: "", cidade: SAO_PAULO, raio: 0 }, ana.token);
  assert.equal(await vePedido(bel.token), 1);
  assert.equal(await vePedido(bel.token, SAO_PAULO), 1);

  // configurações do perfil: nome e cidade
  const cfg = (await call("POST", "/api/perfil", { nome: "Ana Maria Souza", cidade: JUNDIAI }, ana.token)).j;
  assert.equal(cfg.cidade, "Jundiaí - SP");
  assert.equal((await call("GET", "/api/eu", null, ana.token)).j.nome, "Ana Maria Souza");
  assert.equal((await call("POST", "/api/perfil", { cidade: 123 }, ana.token)).s, 400);
  assert.equal((await call("GET", `/api/profissionais/${joao.usuario.id}`, null, ana.token)).j.cidade, "Sumaré - SP");
});
