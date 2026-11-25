import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { criaManipulador } from "../server/index.js";
import { abreBanco, converteParametros, schemaPostgres } from "../server/db.js";

async function sobe() {
  const banco = abreBanco({ arquivo: ":memory:" });
  const srv = http.createServer(criaManipulador({ obterBanco: () => banco, secret: "teste" }));
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
  return { call, fecha };
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
