// Camada de banco com dois adaptadores:
//  - Postgres (produção, ex.: Neon na Vercel): usado quando existe DATABASE_URL
//  - SQLite (desenvolvimento local e testes): usado quando não existe
// Todo o SQL do app usa "?" como parâmetro e funciona nos dois.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios(
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE, senha TEXT NOT NULL,
  papel TEXT NOT NULL CHECK(papel IN ('cliente','profissional')),
  criado TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pedidos(
  id INTEGER PRIMARY KEY, cliente_id INTEGER NOT NULL REFERENCES usuarios(id),
  titulo TEXT NOT NULL, categoria TEXT NOT NULL, descricao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto', orcamento_aceito INTEGER,
  concluido INTEGER NOT NULL DEFAULT 0, nota INTEGER, comentario TEXT,
  criado TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS orcamentos(
  id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  pro_id INTEGER NOT NULL REFERENCES usuarios(id), valor INTEGER NOT NULL,
  prazo TEXT NOT NULL, mensagem TEXT NOT NULL DEFAULT '',
  criado TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(pedido_id, pro_id));
CREATE TABLE IF NOT EXISTS mensagens(
  id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  papel TEXT NOT NULL, texto TEXT NOT NULL,
  criado TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pagamentos(
  id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id),
  orcamento_id INTEGER NOT NULL, valor INTEGER NOT NULL, taxa INTEGER NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL, ref TEXT, criado TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_orc_pedido ON orcamentos(pedido_id);
CREATE INDEX IF NOT EXISTS ix_msg_pedido ON mensagens(pedido_id);
CREATE INDEX IF NOT EXISTS ix_ped_cliente ON pedidos(cliente_id);
`;
// Valores em dinheiro ficam em centavos (inteiros) para evitar erros de arredondamento.

export const schemaPostgres = () =>
  SCHEMA.replace(/INTEGER PRIMARY KEY/g, "SERIAL PRIMARY KEY").replace(
    /TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP/g,
    "TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"
  );

export const converteParametros = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + ++i);
};

async function sqlite(arquivo) {
  const { DatabaseSync } = await import("node:sqlite");
  if (arquivo !== ":memory:") mkdirSync(dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec("PRAGMA foreign_keys = ON;");
  if (arquivo !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const api = {
    all: async (s, ...a) => db.prepare(s).all(...a),
    one: async (s, ...a) => db.prepare(s).get(...a),
    run: async (s, ...a) => {
      db.prepare(s).run(...a);
    },
    ins: async (s, ...a) => Number(db.prepare(s).run(...a).lastInsertRowid),
    async tx(fn) {
      db.exec("BEGIN");
      try {
        const r = await fn(api);
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    ehDuplicado: (e) => /UNIQUE/.test(String(e.message)),
    fechar: async () => db.close(),
  };
  return api;
}

async function postgres(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000 });
  const mk = (c) => ({
    all: async (s, ...a) => (await c.query(converteParametros(s), a)).rows,
    one: async (s, ...a) => (await c.query(converteParametros(s), a)).rows[0],
    run: async (s, ...a) => {
      await c.query(converteParametros(s), a);
    },
    ins: async (s, ...a) => (await c.query(converteParametros(s) + " RETURNING id", a)).rows[0].id,
  });
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(7351)"); // evita corrida entre instâncias ao criar as tabelas
    await c.query(schemaPostgres());
  } finally {
    try {
      await c.query("SELECT pg_advisory_unlock(7351)");
    } catch {}
    c.release();
  }
  return {
    ...mk(pool),
    async tx(fn) {
      const cl = await pool.connect();
      try {
        await cl.query("BEGIN");
        const r = await fn(mk(cl));
        await cl.query("COMMIT");
        return r;
      } catch (e) {
        try {
          await cl.query("ROLLBACK");
        } catch {}
        throw e;
      } finally {
        cl.release();
      }
    },
    ehDuplicado: (e) => e.code === "23505",
    fechar: () => pool.end(),
  };
}

export const abreBanco = ({ url, arquivo }) => (url ? postgres(url) : sqlite(arquivo || ":memory:"));

// Abre o banco na primeira requisição e reaproveita a conexão. Se falhar, tenta de novo na próxima.
export function bancoDoAmbiente() {
  let p = null;
  return () =>
    (p ??= (async () => {
      const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      if (!url && process.env.VERCEL) throw new Error("DATABASE_URL não configurada");
      return abreBanco({ url, arquivo: process.env.DB_FILE || "./data/fazoo.db" });
    })().catch((e) => {
      p = null;
      throw e;
    }));
}
