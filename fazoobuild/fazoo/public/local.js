// Cidades: seletor com busca, cidade do topo (filtro) e tela "Encontrar profissionais".
// Carregado antes de app.js; usa $, esc, api, toast, render, ME, V e D definidos lá.

const CID_KEY = "fazoo_cid";
const RAIOS = [0, 10, 25, 50, 100];
const nomeRaio = (r) => (r ? `${r} km` : "Só na cidade");
const fmtCid = (c) => (c ? `${c.nome} - ${c.uf}` : "");
const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Cidade escolhida no topo. Começa com a cidade do perfil e fica guardada neste aparelho.
let CID = null;
try { CID = JSON.parse(localStorage.getItem(CID_KEY) || "null"); } catch (e) {}
const cidAtual = () => CID || (typeof ME !== "undefined" && ME && ME.cidade) || null;
function trocaCidTopo(c) {
  CID = c;
  try { localStorage.setItem(CID_KEY, JSON.stringify(c)); } catch (e) {}
}
const qCid = () => (cidAtual() ? `?cidade=${cidAtual().id}` : "");

// ---------- Lista de municípios (5.570), carregada só quando precisa ----------
let CIDADES = null;
async function carregaCidades() {
  if (CIDADES) return CIDADES;
  const r = await fetch("/cidades.json");
  CIDADES = (await r.json()).map(([id, nome, uf]) => ({ id, nome, uf, k: semAcento(nome + " " + uf) }));
  return CIDADES;
}
function buscaCidades(txt) {
  const t = semAcento(txt.trim());
  if (!CIDADES || t.length < 2) return [];
  const comeca = [], contem = [];
  for (const c of CIDADES) {
    if (c.k.startsWith(t)) comeca.push(c);
    else if (c.k.includes(t)) contem.push(c);
    if (comeca.length >= 12) break;
  }
  return comeca.concat(contem).slice(0, 12);
}

// ---------- Seletor de cidade (janela por cima da tela) ----------
let ESCOLHA = null; // função chamada com a cidade escolhida
function abreCidades(titulo, aoEscolher) {
  ESCOLHA = aoEscolher;
  const cp = $("#cp");
  cp.innerHTML =
    `<div class="cpb"><div class="sp"><b>${esc(titulo)}</b><button class="b2 sm" data-a="cpFecha">Fechar</button></div>` +
    `<input id="cpq" placeholder="Digite o nome da cidade" autocomplete="off"><div id="cpr" class="cpr"><div class="nt">Carregando cidades…</div></div></div>`;
  cp.style.display = "flex";
  $("#cpq").focus();
  carregaCidades()
    .then(() => mostraCidades())
    .catch(() => ($("#cpr").innerHTML = '<div class="nt">Não foi possível carregar a lista de cidades.</div>'));
}
function mostraCidades() {
  const q = $("#cpq");
  if (!q) return;
  const lista = buscaCidades(q.value);
  $("#cpr").innerHTML = lista.length
    ? lista.map((c) => `<button class="cpi" data-a="cpPega" data-id="${c.id}">${esc(c.nome)} <span class="nt">${c.uf}</span></button>`).join("")
    : `<div class="nt">${q.value.trim().length < 2 ? "Digite pelo menos 2 letras." : "Nenhuma cidade encontrada."}</div>`;
}
const fechaCidades = () => {
  $("#cp").style.display = "none";
  ESCOLHA = null;
};
document.addEventListener("input", (e) => e.target.id == "cpq" && mostraCidades());
document.addEventListener("keydown", (e) => {
  if (e.key == "Escape" && $("#cp").style.display == "flex") fechaCidades();
  if (e.key == "Enter" && e.target.id == "cpq") $("#cpr .cpi")?.click();
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-a]");
  if (e.target.id == "cp") return fechaCidades(); // toque fora da janela
  if (!b) return;
  const a = b.dataset.a;
  if (a == "cpFecha") fechaCidades();
  else if (a == "cpPega") {
    const c = CIDADES.find((x) => x.id == b.dataset.id);
    const f = ESCOLHA;
    fechaCidades();
    if (c && f) {
      try {
        await f({ id: c.id, nome: c.nome, uf: c.uf });
      } catch (err) {
        toast(err.message);
      }
    }
  }
});

// ---------- Botão da cidade no topo ----------
const botaoCidTopo = () => {
  const c = cidAtual();
  return `<button class="cid" data-a="cidTopo" title="Trocar a cidade">📍 ${c ? esc(c.nome) : "Escolher cidade"} ▾</button>`;
};

// ---------- Alcance do pedido (raio em km) ----------
function alcance(F) {
  const n = F.npros;
  return (
    `<div class="cd"><div class="sp"><span>📍 Serviço em <b>${esc(fmtCid(F.cid) || "—")}</b></span><button class="lk" data-a="cidPedido">trocar</button></div>` +
    `<div class="nt">Até onde os profissionais podem estar:</div><div class="chips">${RAIOS.map(
      (r) => `<button class="chp${F.raio == r ? " on" : ""}" data-a="raioPed" data-r="${r}">${nomeRaio(r)}</button>`
    ).join("")}</div>` +
    `<div class="nt">${n == null ? "Contando profissionais…" : n == 0 ? "Nenhum profissional cadastrado nessa área ainda. Aumente o alcance para mais pessoas verem." : `${n} profissiona${n > 1 ? "is" : "l"} nessa área ${n > 1 ? "verão" : "verá"} o pedido.`}</div></div>`
  );
}
let contaSeq = 0;
async function contaPros(F) {
  F.npros = null;
  if (!F.cid) return;
  const seq = ++contaSeq;
  try {
    const r = await api("GET", `/profissionais?cidade=${F.cid.id}&raio=${F.raio}`);
    if (seq == contaSeq) F.npros = r.total;
  } catch (e) {
    F.npros = undefined;
  }
  if (V.n == "new" || V.n == "edit") render(true);
}

// ---------- Tela "Encontrar profissionais" ----------
const BUSCA = { raio: 25, cat: "", res: null, chave: "" };
async function carregaPros(forcar) {
  const c = cidAtual();
  if (!c) return;
  const chave = `${c.id}|${BUSCA.raio}|${BUSCA.cat}`;
  if (!forcar && BUSCA.chave == chave && BUSCA.res) return;
  BUSCA.chave = chave;
  BUSCA.res = null;
  render(true);
  const r = await api("GET", `/profissionais?cidade=${c.id}&raio=${BUSCA.raio}&categoria=${encodeURIComponent(BUSCA.cat)}`);
  if (BUSCA.chave == chave) BUSCA.res = r;
  render(true);
}
const distTxt = (d) => (d == 0 ? "na cidade" : `${d} km`);
function prosV() {
  const c = cidAtual();
  if (!c) return head("Profissionais", "", 1) + `<div class="pd">${tip("Escolha uma cidade no topo da tela para ver os profissionais da região.")}</div>`;
  if (!BUSCA.res && BUSCA.chave != `${c.id}|${BUSCA.raio}|${BUSCA.cat}`) carregaPros();
  const r = BUSCA.res;
  return (
    head("Profissionais", `Perto de ${esc(fmtCid(c))}`, 1) +
    `<div class="pd"><div class="chips">${RAIOS.map((x) => `<button class="chp${BUSCA.raio == x ? " on" : ""}" data-a="raioBusca" data-r="${x}">${nomeRaio(x)}</button>`).join("")}</div>` +
    `<select id="bcat"><option value="">Todos os serviços</option>${CATS.map((x) => `<option${x == BUSCA.cat ? " selected" : ""}>${x}</option>`).join("")}</select>` +
    (!r
      ? '<div class="nt c">Buscando…</div>'
      : `<div class="nt">${r.total} profissiona${r.total == 1 ? "l" : "is"} encontrado${r.total == 1 ? "" : "s"}</div>` +
        (r.profissionais
          .map((x) =>
            `<div class="cd tap" data-a="pro" data-pid="${x.id}"><div class="r">${av(x.i)}<div class="f"><b>${esc(x.nome)}</b><div class="nt">${esc(x.cidade)} · ${distTxt(x.dist)}</div></div><div class="c"><b>${
              x.media == null ? "Novo" : "★ " + String(x.media.toFixed(1)).replace(".", ",")
            }</b><div class="nt">${x.servicos} serviço${x.servicos == 1 ? "" : "s"}</div></div></div>${
              x.categorias.length ? `<div class="chips">${x.categorias.map((k) => `<span class="ch">${esc(k)}</span>`).join("")}</div>` : ""
            }</div>`
          )
          .join("") || tip("Nenhum profissional nessa área ainda. Tente aumentar a distância."))) +
    "</div>"
  );
}
document.addEventListener("change", (e) => {
  if (e.target.id == "bcat") {
    BUSCA.cat = e.target.value;
    carregaPros().catch((err) => toast(err.message));
  }
});
