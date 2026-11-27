const TOK_KEY = "fazoo_tok";
let TOK = null, ME = null, D = { ps: [] }, V = { n: "home" }, star = 5, modo = "login", pronto = false;
try { TOK = localStorage.getItem(TOK_KEY); } catch (e) {}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const R = (v) => "R$ " + Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const P = (id) => D.ps.find((p) => p.id == id);
const ST = { aberto: "Recebendo orçamentos", and: "Em andamento", fin: "Concluído", dis: "Em análise do suporte" };

const api = async (m, u, b) => {
  const r = await fetch("/api" + u, {
    method: m,
    headers: { "Content-Type": "application/json", ...(TOK ? { Authorization: "Bearer " + TOK } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || "Algo deu errado");
  return j;
};
const toast = (m, ok) => {
  const t = $("#toast");
  t.textContent = m;
  t.classList.toggle("ok", !!ok);
  t.style.display = "block";
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.style.display = "none"), 4000);
};
const load = async () => { D.ps = await api("GET", "/pedidos"); };
const guarda = (t) => { try { t ? localStorage.setItem(TOK_KEY, t) : localStorage.removeItem(TOK_KEY); } catch (e) {} };

const av = (i) => `<div class="av">${esc(i)}</div>`;
const card = (x, c = "") => `<div class="cd ${c}">${x}</div>`;
const tap = (a, id, x) => `<div class="cd tap" data-a="${a}" data-id="${id}">${x}</div>`;
const row = (l, r) => `<div class="sp"><span>${l}</span><span>${r}</span></div>`;
const tip = (x) => card(x, "tip");
const head = (t, s, back) =>
  `<div class="hd">${back ? '<button class="bk" data-a="back">‹ Voltar</button>' : ""}<div class="b">${t}</div>${s ? `<div class="sub">${s}</div>` : ""}</div>`;
const bar = () => `<div class="rl"><span>Fazoo</span><span class="nt" style="flex:none">${esc(ME.nome)}</span><button data-a="sair">Sair</button></div>`;
const primeiro = () => esc(ME.nome.split(" ")[0]);

const steps = (p, me) => {
  const a = p.ac != null, f = p.st == "fin", o = a ? p.orc[p.ac] : null;
  const L = [
    ["Pedido publicado", 1],
    [a ? "Orçamento aceito · " + esc(o.p) : "Orçamento aceito", a ? 1 : 0],
    [a ? "Pagamento retido · " + R(me == "p" ? o.v : p.pg ? p.pg.total : o.v * 1.1) : "Pagamento retido", a ? 1 : 0],
    ["Em execução", f ? 1 : a ? (p.cn ? 1 : 2) : 0],
    ["Concluído", f ? 1 : p.cn ? 2 : 0],
  ];
  return `<div class="steps">` + L.map(([t, s]) => `<div class="r${s ? "" : " mut"}"><span class="st s${s}">${s == 1 ? "✓" : ""}</span>${s == 2 ? `<b>${t}</b>` : t}</div>`).join("") + "</div>";
};
const chat = (p, me) =>
  `<h3>Conversa</h3><div class="chat">${p.ch.length ? p.ch.map((m) => `<div class="${m.w == me ? "m2" : "m1"}">${esc(m.t)}</div>`).join("") : '<div class="nt">Nenhuma mensagem ainda.</div>'}</div><div class="msg"><input id="mi" placeholder="Escreva uma mensagem" maxlength="300"><button class="snd" data-a="msg" data-id="${p.id}">Enviar</button></div>`;

function svc(p, me) {
  let h = steps(p, me), o = p.orc[p.ac];
  if (me == "c") {
    h += tap("pro", "", `<div class="r">${av(o.i)}<div class="f"><b>${esc(o.p)}</b><div class="nt">${esc(o.n)}</div></div><span class="nt">Ver perfil ›</span></div>`).replace('data-id=""', `data-pid="${o.pid}"`);
    if (p.st == "and" && p.cn)
      h += card(`<b>${esc(o.p)} marcou o serviço como concluído.</b><div class="nt">Confirme para liberar ${R(o.v)} ao profissional.</div>`) +
        `<button class="bt" data-a="ok" data-id="${p.id}">Confirmar e liberar pagamento</button><button class="b2" data-a="dis" data-id="${p.id}">Algo deu errado</button>`;
    else if (p.st == "and") h += tip("Seu dinheiro está protegido até você confirmar a conclusão.");
    if (p.st == "dis") h += tip("O suporte foi acionado e vai conversar com os dois lados para definir a melhor solução.");
    if (p.st == "fin") {
      h += tip("Pagamento liberado ao profissional.");
      h += p.av
        ? card(`<div class="c"><span style="color:var(--a);font-size:22px">${"★".repeat(p.av)}</span><div class="nt">${p.avt ? "“" + esc(p.avt) + "”" : "Obrigado pela avaliação."}</div></div>`)
        : card(`<b class="c">Como foi com ${esc(o.p)}?</b><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button class="sb on" data-a="star" data-n="${n}">★</button>`).join("")}</div><input id="rc" placeholder="Conte como foi o serviço" maxlength="200">`) +
          `<button class="bt" data-a="rate" data-id="${p.id}">Enviar avaliação</button>`;
    }
  } else {
    if (p.st == "and" && !p.cn) h += `<button class="bt" data-a="done" data-id="${p.id}">Marcar como concluído</button><button class="b2" data-a="dis" data-id="${p.id}">Algo deu errado</button>`;
    else if (p.st == "and") h += tip("Aguardando o cliente confirmar a conclusão. O pagamento será liberado em seguida.") + `<button class="b2" data-a="dis" data-id="${p.id}">Algo deu errado</button>`;
    if (p.st == "dis") h += tip("O suporte foi acionado e vai conversar com você e com o cliente.");
    if (p.st == "fin") {
      h += tip(`Pagamento liberado: ${R(o.v)}.`);
      h += p.avc
        ? card(`<div class="c"><div class="nt">Sua avaliação do cliente</div><span style="color:var(--a);font-size:22px">${"★".repeat(p.avc.nota)}</span>${p.avc.comentario ? `<div class="nt">“${esc(p.avc.comentario)}”</div>` : ""}</div>`)
        : card(`<b class="c">Como foi atender ${esc(p.cli ? p.cli.nome : "o cliente")}?</b><div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button class="sb on" data-a="star" data-n="${n}">★</button>`).join("")}</div><input id="rc" placeholder="Ex.: educado, pagou certinho, local acessível" maxlength="200">`) +
          `<button class="bt" data-a="rateCli" data-id="${p.id}">Avaliar cliente</button>`;
    }
  }
  return h + chat(p, me);
}

const authV = () =>
  head("Fazoo", "Serviços para a sua casa, com pagamento protegido") +
  `<div class="pd"><div class="two"><button class="b2 tab ${modo == "login" ? "on2" : ""}" data-a="modo" data-w="login">Entrar</button><button class="b2 tab ${modo == "reg" ? "on2" : ""}" data-a="modo" data-w="reg">Criar conta</button></div>${
    modo == "reg"
      ? '<input id="no" placeholder="Seu nome" maxlength="80" autocomplete="name"><select id="pa"><option value="cliente">Quero contratar serviços</option><option value="profissional">Sou profissional</option></select>'
      : ""
  }<input id="em" type="email" placeholder="E-mail" maxlength="120" autocomplete="email"><input id="se" type="password" placeholder="Senha (mínimo 6 caracteres)" maxlength="100" autocomplete="${modo == "reg" ? "new-password" : "current-password"}"><button class="bt" data-a="auth">${modo == "reg" ? "Criar conta" : "Entrar"}</button></div>`;

const homeC = () =>
  head("Olá, " + primeiro(), "Seus pedidos") +
  `<div class="pd"><button class="bt" data-a="new">+ Novo pedido</button><button class="b2" data-a="meu">Meu perfil</button>` +
  (D.ps.map((p) => tap("open", p.id, `<div class="sp"><b>${esc(p.t)}</b><span class="ch">${ST[p.st]}</span></div><div class="nt">${p.ac != null ? esc(p.orc[p.ac].p) : p.orc.length + " orçamento(s) recebido(s)"}</div>`)).join("") ||
    '<div class="nt c">Você ainda não publicou pedidos.</div>') +
  "</div>";
const newC = () =>
  head("Novo pedido", "Descreva o que você precisa", 1) +
  `<div class="pd"><select id="cat">${CATS.map((c) => `<option${c == NOVO.cat ? " selected" : ""}>${c}</option>`).join("")}</select>` +
  `<input id="t" placeholder="Ex.: Trocar tomadas do quarto" maxlength="80" value="${esc(NOVO.t)}">` +
  `<textarea id="d" placeholder="Detalhes do serviço" maxlength="400">${esc(NOVO.d)}</textarea>` +
  barraAnexos() +
  (ENVIO ? `<div class="cd tip c" id="envio">${esc(ENVIO)}</div>` : "") +
  `<button class="bt" data-a="pub"${ENVIO || GRAV ? " disabled" : ""}>Publicar pedido</button></div>`;
const detC = (p) =>
  head(esc(p.t), ST[p.st], 1) + `<div class="pd">` + card(`<div class="nt">${esc(p.c)}</div>${esc(p.d || "Sem detalhes.")}`) + galeria(p) +
  (p.st == "aberto"
    ? `<h3>Orçamentos</h3>` +
      (p.orc.map((o, i) => card(`<div class="r">${av(o.i)}<div class="f"><b>${esc(o.p)}</b><div class="nt">${esc(o.n)} · ${esc(o.z)}</div></div><b>${R(o.v)}</b></div>${o.m ? `<div class="nt">“${esc(o.m)}”</div>` : ""}<div class="two"><button class="b2 tab" data-a="pro" data-pid="${o.pid}">Ver perfil</button><button class="b2 tab" data-a="acc" data-id="${p.id}" data-i="${i}">Aceitar</button></div>`)).join("") ||
        '<div class="nt">Aguardando profissionais…</div>')
    : svc(p, "c")) + "</div>";
const payC = (p, i) => {
  const o = p.orc[i];
  return head("Pagamento", esc(p.t), 1) + `<div class="pd">` + card(`<div class="r">${av(o.i)}<b>${esc(o.p)}</b></div>`) +
    card(row("Orçamento", R(o.v)) + row("Taxa Fazoo (10%)", R(o.v * 0.1)) + `<div class="sp tot"><span>Total</span><span>${R(o.v * 1.1)}</span></div>`) +
    tip("O dinheiro fica retido e só é liberado quando você confirmar a conclusão.") +
    `<button class="bt" data-a="pay" data-id="${p.id}" data-i="${i}">Pagar (simulado)</button><div class="nt c">Nesta versão nenhuma cobrança real é feita.</div></div>`;
};

function homeP() {
  const n = D.ps.filter((p) => p.st == "aberto" && !p.jaOrcou), e = D.ps.filter((p) => p.st == "aberto" && p.jaOrcou), m = D.ps.filter((p) => p.meu);
  const sum = (f) => m.filter(f).reduce((s, p) => s + p.orc[p.ac].v, 0);
  return head("Olá, " + primeiro(), "Painel do profissional") +
    `<div class="pd"><button class="b2" data-a="meu">Meu perfil público</button><div class="two"><div class="cd"><div class="nt">Retido</div><div class="big">${R(sum((p) => p.st == "and" || p.st == "dis"))}</div></div><div class="cd"><div class="nt">Liberado</div><div class="big">${R(sum((p) => p.st == "fin"))}</div></div></div><h3>Novos pedidos</h3>` +
    (n.map((p) => tap("pq", p.id, `<div class="sp"><b>${esc(p.t)}</b><span class="ch">novo</span></div><div class="nt">${esc(p.c)} · ${p.norc} orçamento(s) já enviados</div>`)).join("") || '<div class="nt">Nenhum pedido novo no momento.</div>') +
    (e.length ? "<h3>Orçamentos enviados</h3>" + e.map((p) => card(`<b>${esc(p.t)}</b><div class="nt">Aguardando o cliente decidir.</div>`)).join("") : "") +
    (m.length ? "<h3>Meus serviços</h3>" + m.map((p) => tap("open", p.id, `<div class="sp"><b>${esc(p.t)}</b><span class="ch">${ST[p.st]}</span></div><div class="nt">${R(p.orc[p.ac].v)}</div>`)).join("") : "") + "</div>";
}
const cliCard = (p) =>
  p.cli ? `<div class="cd tap" data-a="cli" data-cid="${p.cli.id}"><div class="r">${av(p.cli.i)}<div class="f"><div class="nt">Cliente</div><b>${esc(p.cli.nome)}</b><div class="nt">${esc(p.cli.n)}</div></div><span class="nt">Ver perfil ›</span></div></div>` : "";
const qP = (p) =>
  head("Enviar orçamento", esc(p.t), 1) + `<div class="pd">` + card(`<div class="nt">${esc(p.c)}</div>${esc(p.d || "Sem detalhes.")}`) + galeria(p) + cliCard(p) +
  `<input id="qv" type="number" inputmode="decimal" min="1" placeholder="Valor do serviço (R$)"><input id="qz" placeholder="Prazo. Ex.: 2 dias" maxlength="30"><textarea id="qm" placeholder="Mensagem para o cliente" maxlength="300"></textarea>` +
  tip("Você recebe o valor integral do orçamento. A taxa de 10% é paga pelo cliente.") + `<button class="bt" data-a="quote" data-id="${p.id}">Enviar orçamento</button></div>`;
const detP = (p) => head(esc(p.t), ST[p.st], 1) + `<div class="pd">` + card(`<div class="nt">${esc(p.c)}</div>${esc(p.d || "Sem detalhes.")}`) + galeria(p) + cliCard(p) + (p.meu ? svc(p, "p") : "") + "</div>";

const mes = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(" de ", "/").replace(".", "") : "");
const estrelas = (n) => `<span class="es">${"★".repeat(n)}<span class="es0">${"★".repeat(5 - n)}</span></span>`;

// Perfil público (o que o cliente vê). "eu" = o próprio profissional vendo a prévia.
function perfil(x, eu) {
  const nota = x.media == null ? "–" : String(x.media.toFixed(1)).replace(".", ",");
  return (
    `<div class="hd pf">${'<button class="bk" data-a="back">‹ Voltar</button>'}<div class="avg">${esc(x.i)}</div><div class="b">${esc(x.nome)}</div>` +
    `<div class="sub">${x.cidade ? esc(x.cidade) + " · " : ""}No Fazoo desde ${mes(x.desde)}</div></div>` +
    `<div class="pd"><div class="tres"><div class="cd c"><div class="big">${x.media == null ? "–" : "★ " + nota}</div><div class="nt">${x.avaliacoes} ${x.avaliacoes == 1 ? "avaliação" : "avaliações"}</div></div>` +
    `<div class="cd c"><div class="big">${x.servicos}</div><div class="nt">serviço${x.servicos == 1 ? "" : "s"} concluído${x.servicos == 1 ? "" : "s"}</div></div></div>` +
    (x.categorias.length ? `<div class="chips">${x.categorias.map((c) => `<span class="ch">${esc(c)}</span>`).join("")}</div>` : "") +
    `<h3>Sobre</h3>` + card(x.bio ? `<div class="bio">${esc(x.bio)}</div>` : `<div class="nt">${eu ? "Você ainda não escreveu sobre você." : "Este profissional ainda não escreveu sobre ele."}</div>`) +
    `<h3>Avaliações de clientes</h3>` +
    (x.lista.length
      ? x.lista.map((a) => card(`<div class="sp">${estrelas(a.nota)}<span class="nt">${mes(a.data)}</span></div>${a.comentario ? `<div>“${esc(a.comentario)}”</div>` : ""}<div class="nt">${esc(a.cliente)} · ${esc(a.categoria)}</div>`)).join("")
      : `<div class="nt">${x.servicos ? "Os clientes ainda não deixaram comentários." : "Ainda sem serviços concluídos pelo Fazoo."}</div>`) +
    (eu ? editor(x) : "") + "</div>"
  );
}
function perfilCli(x, eu) {
  const nota = x.media == null ? "–" : "★ " + String(x.media.toFixed(1)).replace(".", ",");
  return (
    `<div class="hd pf"><button class="bk" data-a="back">‹ Voltar</button><div class="avg">${esc(x.i)}</div><div class="b">${esc(x.nome)}</div>` +
    `<div class="sub">Cliente${x.cidade ? " · " + esc(x.cidade) : ""} · No Fazoo desde ${mes(x.desde)}</div></div>` +
    `<div class="pd">` + (eu ? tip("É assim que os profissionais veem o seu perfil.") : "") +
    `<div class="tres"><div class="cd c"><div class="big">${nota}</div><div class="nt">${x.avaliacoes} ${x.avaliacoes == 1 ? "avaliação" : "avaliações"}</div></div>` +
    `<div class="cd c"><div class="big">${x.servicos}</div><div class="nt">serviço${x.servicos == 1 ? "" : "s"} contratado${x.servicos == 1 ? "" : "s"}</div></div></div>` +
    `<h3>Avaliações dos profissionais</h3>` +
    (x.lista.length
      ? x.lista.map((a) => card(`<div class="sp">${estrelas(a.nota)}<span class="nt">${mes(a.data)}</span></div>${a.comentario ? `<div>“${esc(a.comentario)}”</div>` : ""}<div class="nt">${esc(a.autor)} · ${esc(a.categoria)}</div>`)).join("")
      : `<div class="nt">${eu ? "Você" : "Este cliente"} ainda não recebeu avaliações.</div>`) +
    (eu
      ? `<h3>Editar meu perfil</h3><div class="cd"><input id="pci" placeholder="Cidade. Ex.: Campinas - SP" maxlength="60" value="${esc(x.cidade)}"><div class="nt">Seu nome aparece abreviado e seu e-mail nunca é mostrado.</div></div><button class="bt" data-a="salvaPerfil">Salvar perfil</button>`
      : "") +
    "</div>"
  );
}
const CATS = ["Ar-condicionado", "Reparo elétrico", "Encanamento", "Construção civil", "Pintura"];
const editor = (x) =>
  `<h3>Editar meu perfil</h3><div class="cd"><div class="nt">Serviços que você faz</div><div class="chips">${CATS.map((c) => `<label class="ck"><input type="checkbox" class="pc" value="${c}"${x.categorias.includes(c) ? " checked" : ""}> ${c}</label>`).join("")}</div>` +
  `<input id="pci" placeholder="Cidade. Ex.: Campinas - SP" maxlength="60" value="${esc(x.cidade)}">` +
  `<textarea id="pbi" placeholder="Conte sua experiência, tempo de profissão, diferenciais…" maxlength="500">${esc(x.bio)}</textarea></div>` +
  `<button class="bt" data-a="salvaPerfil">Salvar perfil</button>`;

function render(keep) {
  let h = "";
  if (!pronto) h = '<div class="pd"><div class="nt c">Carregando…</div></div>';
  else if (!ME) h = authV();
  else {
    const c = ME.papel == "cliente", p = V.id && P(V.id);
    if (V.n == "pro" && D.pro) h = perfil(D.pro, false);
    else if (V.n == "cli" && D.cli) h = perfilCli(D.cli, false);
    else if (V.n == "meu" && D.meu) h = c ? perfilCli(D.meu, true) : perfil(D.meu, true);
    else if (V.n == "new" && c) h = newC();
    else if (V.n == "pay" && c && p && p.orc[V.i]) h = payC(p, V.i);
    else if (V.n == "q" && !c && p) h = qP(p);
    else if (V.n == "det" && p) h = c ? detC(p) : detP(p);
    else h = c ? homeC() : homeP();
    h = bar() + h;
  }
  $("#app").innerHTML = h + `<div class="ft">Versão de testes. Pagamento simulado.</div>`;
  if (!keep) window.scrollTo(0, 0);
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-a]");
  if (!b || b.disabled) return;
  const a = b.dataset.a, id = b.dataset.id, base = "/pedidos/" + id;
  try {
    switch (a) {
      case "modo": modo = b.dataset.w; render(); return;
      case "auth": {
        b.disabled = true;
        const body = { email: $("#em").value, senha: $("#se").value };
        if (modo == "reg") { body.nome = $("#no").value; body.papel = $("#pa").value; }
        try {
          const r = await api("POST", modo == "reg" ? "/registro" : "/login", body);
          TOK = r.token; ME = r.usuario; guarda(TOK);
          await load();
          V = { n: "home" };
        } finally { b.disabled = false; }
        break;
      }
      case "sair": TOK = null; ME = null; guarda(null); D.ps = []; V = { n: "home" }; break;
      case "home": V = { n: "home" }; await load(); break;
      case "back": V = V.de || { n: "home" }; if (V.n == "home" || V.n == "det") await load(); break;
      case "pro": D.pro = await api("GET", "/profissionais/" + b.dataset.pid); V = { n: "pro", de: V }; break;
      case "cli": D.cli = await api("GET", "/clientes/" + b.dataset.cid); V = { n: "cli", de: V }; break;
      case "rateCli": await api("POST", base + "/avaliar-cliente", { nota: star, comentario: ($("#rc") || { value: "" }).value }); await load(); star = 5; break;
      case "meu": D.meu = await api("GET", "/perfil"); V = { n: "meu" }; break;
      case "salvaPerfil": {
        b.disabled = true;
        try {
          D.meu = await api("POST", "/perfil", ME.papel == "cliente" ? { cidade: $("#pci").value } : {
            cidade: $("#pci").value,
            bio: $("#pbi").value,
            categorias: [...document.querySelectorAll(".pc:checked")].map((x) => x.value),
          });
        } finally { b.disabled = false; }
        toast("Perfil salvo!", true);
        break;
      }
      case "new": V = { n: "new" }; break;
      case "open": V = { n: "det", id }; break;
      case "pq": V = { n: "q", id }; break;
      case "pub": {
        guardaForm();
        b.disabled = true;
        let r;
        try { r = await api("POST", "/pedidos", { titulo: NOVO.t, categoria: NOVO.cat, descricao: NOVO.d }); }
        finally { b.disabled = false; }
        if (NOVO.anexos.length) {
          render(true);
          const falhas = await enviaAnexos(r.id);
          if (falhas) toast(`${falhas} anexo(s) não puderam ser enviados. O pedido foi publicado mesmo assim.`);
        }
        limpaNovo();
        await load();
        V = { n: "det", id: r.id };
        break;
      }
      case "acc": V = { n: "pay", id, i: +b.dataset.i, de: V }; break;
      case "pay": b.disabled = true; try { await api("POST", base + "/aceitar", { orcamentoId: P(id).orc[+b.dataset.i].id }); await load(); V = { n: "det", id }; } finally { b.disabled = false; } break;
      case "quote": await api("POST", base + "/orcamentos", { valor: $("#qv").value, prazo: $("#qz").value, mensagem: $("#qm").value }); await load(); V = { n: "home" }; break;
      case "msg": { const t = $("#mi").value.trim(); if (!t) return; await api("POST", base + "/mensagens", { texto: t }); await load(); break; }
      case "done": await api("POST", base + "/concluir", {}); await load(); break;
      case "ok": b.disabled = true; try { await api("POST", base + "/confirmar", {}); await load(); } finally { b.disabled = false; } break;
      case "dis": await api("POST", base + "/disputa", {}); await load(); break;
      case "star": star = +b.dataset.n; document.querySelectorAll(".sb").forEach((x) => x.classList.toggle("on", +x.dataset.n <= star)); return;
      case "rate": await api("POST", base + "/avaliar", { nota: star, comentario: ($("#rc") || { value: "" }).value }); await load(); star = 5; break;
      default: return;
    }
    render();
  } catch (err) { toast(err.message); }
});
document.addEventListener("keydown", (e) => {
  if (e.key == "Enter" && e.target.id == "mi") { const b = $('[data-a="msg"]'); if (b) b.click(); }
});
// Atualiza a lista sozinha a cada 15 s (ex.: novos orçamentos), sem atrapalhar quem está digitando.
setInterval(async () => {
  if (!ME || document.hidden || V.n == "meu" || V.n == "new" || tocandoMidia()) return;
  const f = document.activeElement;
  if (f && /INPUT|TEXTAREA|SELECT/.test(f.tagName)) return;
  try { await load(); render(true); } catch (e) {}
}, 15000);
(async () => {
  if (TOK) { try { ME = await api("GET", "/eu"); await load(); } catch (e) { TOK = null; ME = null; guarda(null); } }
  pronto = true;
  render();
})();
