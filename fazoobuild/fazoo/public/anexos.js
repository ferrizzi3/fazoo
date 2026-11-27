// Fotos, vídeos e áudios do pedido.
// Carregado antes de app.js; usa $, esc, api, toast e render definidos lá.

const MBy = 1024 * 1024;
const LIMITE = {
  foto: { qtd: 30, nome: "fotos" },
  video: { qtd: 2, dur: 60, max: 30 * MBy, nome: "vídeos" },
  audio: { qtd: 3, dur: 180, nome: "áudios" },
};
// Formulário do novo pedido fica guardado aqui para não se perder quando a tela é redesenhada.
const NOVO = { cat: "Ar-condicionado", t: "", d: "", anexos: [] };
const ANXV = {}; // anexos já carregados de cada pedido: id -> { lista, em }
const ABERTAS = new Set(); // pedidos com a galeria de fotos expandida
const FOTOS_VISIVEIS = 8;
let GRAV = null; // gravação de áudio em andamento
let ENVIO = null; // texto de progresso do envio

const tipoBase = (m) => String(m || "").split(";")[0].trim().toLowerCase();
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const qtdTipo = (t) => NOVO.anexos.filter((a) => a.tipo == t).length;

function guardaForm() {
  if (!$("#t")) return;
  NOVO.t = $("#t").value;
  NOVO.d = $("#d").value;
  NOVO.cat = $("#cat").value;
}
function limpaNovo() {
  NOVO.anexos.forEach((a) => URL.revokeObjectURL(a.url));
  Object.assign(NOVO, { cat: "Ar-condicionado", t: "", d: "", anexos: [] });
}

// ---------- Tela do novo pedido ----------
function barraAnexos() {
  const prev = NOVO.anexos
    .map((a, i) => {
      const x = `<button class="rmx" data-a="rmA" data-k="${i}" aria-label="Remover">×</button>`;
      if (a.tipo == "foto") return `<div class="th">${x}<img src="${a.url}" alt=""></div>`;
      if (a.tipo == "video") return `<div class="th">${x}<video src="${a.url}" muted playsinline preload="metadata"></video><span class="tg">▶ ${fmtDur(a.dur)}</span></div>`;
      return `<div class="au">${x}<span class="mi">🎤</span><audio src="${a.url}" controls preload="metadata"></audio></div>`;
    })
    .join("");
  const rec = GRAV
    ? `<div class="rec"><span class="dot"></span><span id="rt">${fmtDur((Date.now() - GRAV.ini) / 1000)}</span><span class="f nt">${GRAV.travado ? "Gravando…" : "Solte para terminar"}</span>${
        GRAV.travado ? `<button class="b2 sm" data-a="recCancel">Cancelar</button><button class="bt sm" data-a="recOk">✓</button>` : ""
      }</div>`
    : "";
  return (
    `<div class="nt">Anexos (opcional): mostre o problema com fotos, vídeo ou um áudio.</div>` +
    `<div class="anx">` +
    `<label class="b2 ab"><input type="file" id="inF" accept="image/*" multiple hidden>📷 Foto</label>` +
    `<label class="b2 ab"><input type="file" id="inV" accept="video/*" hidden>🎥 Vídeo</label>` +
    `<button class="b2 ab${GRAV ? " on3" : ""}" id="mic" type="button">🎤 Áudio</button></div>` +
    rec +
    (prev ? `<div class="pv">${prev}</div>` : "") +
    `<div class="nt">Segure 🎤 para gravar e solte para terminar, ou toque uma vez para gravar sem segurar. Os anexos são apagados quando o serviço é concluído.</div>`
  );
}

// Reduz a foto no próprio celular (máx. 1600 px, JPEG) para gastar menos espaço e internet.
async function comprimeFoto(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const b = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
    if (b) return b;
  } catch (e) {}
  if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
  throw new Error("Formato de foto não suportado. Tente uma foto JPG ou PNG.");
}
function duracaoDe(url, tag = "video") {
  return new Promise((ok) => {
    const m = document.createElement(tag);
    m.preload = "metadata";
    m.onloadedmetadata = () => {
      if (m.duration === Infinity) {
        // alguns navegadores só sabem a duração do áudio gravado depois de "pular" para o fim
        m.currentTime = 1e9;
        m.ontimeupdate = () => { m.ontimeupdate = null; ok(m.duration || 0); };
      } else ok(m.duration || 0);
    };
    m.onerror = () => ok(0);
    m.src = url;
  });
}
const tipoVideo = (f) => {
  const t = tipoBase(f.type);
  if (t) return t;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[ext] || "";
};

document.addEventListener("change", async (e) => {
  const inp = e.target;
  if (inp.id != "inF" && inp.id != "inV") return;
  guardaForm();
  const files = [...inp.files];
  inp.value = "";
  try {
    for (const f of files) {
      if (inp.id == "inF") {
        if (qtdTipo("foto") >= LIMITE.foto.qtd) throw new Error(`Máximo de ${LIMITE.foto.qtd} fotos por pedido.`);
        const b = await comprimeFoto(f);
        NOVO.anexos.push({ tipo: "foto", blob: b, mime: tipoBase(b.type), dur: 0, url: URL.createObjectURL(b) });
      } else {
        if (qtdTipo("video") >= LIMITE.video.qtd) throw new Error(`Máximo de ${LIMITE.video.qtd} vídeos por pedido.`);
        const mime = tipoVideo(f);
        if (!["video/mp4", "video/quicktime", "video/webm"].includes(mime)) throw new Error("Formato de vídeo não suportado.");
        if (f.size > LIMITE.video.max) throw new Error("Vídeo grande demais (máximo 30 MB). Grave um vídeo mais curto.");
        const url = URL.createObjectURL(f);
        const dur = await duracaoDe(url);
        if (dur > LIMITE.video.dur + 1) {
          URL.revokeObjectURL(url);
          throw new Error(`O vídeo pode ter no máximo ${LIMITE.video.dur} segundos.`);
        }
        NOVO.anexos.push({ tipo: "video", blob: f, mime, dur, url });
      }
    }
  } catch (err) {
    toast(err.message);
  }
  render(true);
});

// ---------- Gravação de áudio (estilo WhatsApp) ----------
function formatoAudio() {
  for (const m of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"])
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
async function iniciaGravacao() {
  if (GRAV) return;
  if (qtdTipo("audio") >= LIMITE.audio.qtd) return toast(`Máximo de ${LIMITE.audio.qtd} áudios por pedido.`);
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Este navegador não grava áudio.");
  guardaForm();
  const g = { ini: Date.now(), travado: false, partes: [], pedindo: true, soltou: false };
  GRAV = g;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    GRAV = null;
    render(true);
    return toast("Permita o uso do microfone para gravar áudio.");
  }
  if (GRAV !== g) return stream.getTracks().forEach((t) => t.stop());
  const mime = formatoAudio();
  // 32 kbps é suficiente para voz e gasta ~250 KB por minuto.
  g.rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
  g.stream = stream;
  g.rec.ondataavailable = (e) => e.data.size && g.partes.push(e.data);
  g.rec.start(250);
  g.ini = Date.now();
  g.pedindo = false;
  // Se a pessoa soltou o botão enquanto o navegador pedia permissão, segue gravando no modo "travado".
  if (g.soltou) g.travado = true;
  g.timer = setInterval(() => {
    const s = (Date.now() - g.ini) / 1000;
    const el = $("#rt");
    if (el) el.textContent = fmtDur(s);
    if (s >= LIMITE.audio.dur) paraGravacao(true);
  }, 250);
  render(true);
}
function paraGravacao(salvar) {
  const g = GRAV;
  if (!g) return;
  GRAV = null;
  clearInterval(g.timer);
  const fim = () => g.stream && g.stream.getTracks().forEach((t) => t.stop());
  if (!g.rec) return render(true);
  const dur = (Date.now() - g.ini) / 1000;
  g.rec.onstop = () => {
    fim();
    if (salvar && dur >= 1 && g.partes.length) {
      const mime = tipoBase(g.rec.mimeType || g.partes[0].type || "audio/webm");
      const b = new Blob(g.partes, { type: mime });
      NOVO.anexos.push({ tipo: "audio", blob: b, mime, dur: Math.round(dur), url: URL.createObjectURL(b) });
    } else if (salvar) toast("Áudio muito curto.");
    render(true);
  };
  g.rec.stop();
}
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#mic")) {
    e.preventDefault();
    if (GRAV && GRAV.travado) return paraGravacao(true);
    iniciaGravacao();
  }
});
document.addEventListener("pointerup", () => {
  const g = GRAV;
  if (!g || g.travado) return;
  if (g.pedindo) return (g.soltou = true);
  // toque rápido = continua gravando sem segurar; segurou = termina e guarda
  if (Date.now() - g.ini < 600) {
    g.travado = true;
    render(true);
  } else paraGravacao(true);
});
document.addEventListener("contextmenu", (e) => e.target.closest("#mic") && e.preventDefault());

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-a]");
  if (!b) return;
  const a = b.dataset.a;
  if (a == "recOk") paraGravacao(true);
  else if (a == "recCancel") paraGravacao(false);
  else if (a == "rmA") {
    guardaForm();
    const [x] = NOVO.anexos.splice(+b.dataset.k, 1);
    if (x) URL.revokeObjectURL(x.url);
    render(true);
  } else if (a == "maisFotos" || a == "menosFotos") {
    a == "maisFotos" ? ABERTAS.add(+b.dataset.id) : ABERTAS.delete(+b.dataset.id);
    render(true);
  } else if (a == "zoom") {
    const lb = $("#lb");
    lb.innerHTML = `<img src="${esc(b.dataset.src)}" alt="">`;
    lb.style.display = "flex";
  }
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#lb")) $("#lb").style.display = "none";
});

// ---------- Envio ----------
function putArquivo(url, blob, mime, progresso) {
  return new Promise((ok, falha) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Type", mime);
    x.upload.onprogress = (e) => e.lengthComputable && progresso(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? ok() : falha(new Error("Falha no envio (" + x.status + ")")));
    x.onerror = () => falha(new Error("Sem conexão"));
    x.send(blob);
  });
}
function mostraEnvio(t) {
  ENVIO = t;
  const el = $("#envio");
  if (el) el.textContent = t;
}
// Envia os anexos do novo pedido. Retorna quantos falharam.
async function enviaAnexos(pedidoId) {
  const lista = NOVO.anexos;
  let falhas = 0;
  for (let i = 0; i < lista.length; i++) {
    const a = lista[i];
    const rot = `Enviando anexo ${i + 1} de ${lista.length}`;
    mostraEnvio(rot + "…");
    try {
      const r = await api("POST", `/pedidos/${pedidoId}/anexos`, { tipo: a.tipo, mime: a.mime, tamanho: a.blob.size, duracao: Math.round(a.dur) });
      await putArquivo(r.url, a.blob, r.mime, (f) => mostraEnvio(`${rot} · ${Math.round(f * 100)}%`));
      await api("POST", `/pedidos/${pedidoId}/anexos/${r.id}/ok`, {});
    } catch (e) {
      falhas++;
      console.error(e);
    }
  }
  ENVIO = null;
  return falhas;
}

// ---------- Ver anexos de um pedido ----------
async function carregaAnexos(id) {
  ANXV[id] = { ...(ANXV[id] || {}), carregando: true };
  try {
    const r = await api("GET", `/pedidos/${id}/anexos`);
    ANXV[id] = { lista: r.anexos, em: Date.now() };
  } catch (e) {
    ANXV[id] = { lista: [], em: Date.now(), erro: e.message };
  }
  render(true);
}
function galeria(p) {
  if (!p.anx) return "";
  if (!p.anx.n)
    return p.anx.apagados ? `<div class="nt">📎 As fotos, vídeos e áudios deste pedido foram apagados após a conclusão do serviço.</div>` : "";
  const c = ANXV[p.id];
  // links para ver os arquivos valem 1 hora; recarrega antes disso
  if (!c || (!c.carregando && !c.erro && (Date.now() - c.em > 45 * 60000 || c.lista.length != p.anx.n))) carregaAnexos(p.id);
  if (!c || !c.lista) return `<h3>Anexos</h3><div class="nt">Carregando anexos…</div>`;
  if (c.erro) return `<h3>Anexos</h3><div class="nt">${esc(c.erro)}</div>`;
  const fotos = c.lista.filter((a) => a.tipo == "foto");
  const vids = c.lista.filter((a) => a.tipo == "video");
  const auds = c.lista.filter((a) => a.tipo == "audio");
  return (
    `<h3>Anexos</h3>` +
    galFotos(p.id, fotos) +
    vids.map((a) => `<video class="vd" src="${esc(a.url)}" controls playsinline preload="metadata"></video>`).join("") +
    auds.map((a) => `<div class="au"><span class="mi">🎤</span><audio src="${esc(a.url)}" controls preload="metadata"></audio><span class="nt">${fmtDur(a.duracao)}</span></div>`).join("")
  );
}
// Muitas fotos: mostra as primeiras e um quadrado "+N" que abre o resto.
function galFotos(id, fotos) {
  if (!fotos.length) return "";
  const todas = ABERTAS.has(id) || fotos.length <= FOTOS_VISIVEIS;
  const vis = todas ? fotos : fotos.slice(0, FOTOS_VISIVEIS - 1);
  const img = (a) => `<img src="${esc(a.url)}" data-a="zoom" data-src="${esc(a.url)}" alt="Foto do pedido" loading="lazy">`;
  return (
    `<div class="nt">${fotos.length} foto${fotos.length > 1 ? "s" : ""}</div><div class="gal">` +
    vis.map(img).join("") +
    (todas ? "" : `<button class="mais" data-a="maisFotos" data-id="${id}">+${fotos.length - vis.length}</button>`) +
    `</div>` +
    (todas && fotos.length > FOTOS_VISIVEIS ? `<button class="b2 sm" data-a="menosFotos" data-id="${id}">Mostrar menos fotos</button>` : "")
  );
}

// Não redesenha a tela no meio de um vídeo/áudio tocando ou com foto ampliada.
const tocandoMidia = () => [...document.querySelectorAll("#app video, #app audio")].some((m) => !m.paused) || $("#lb")?.style.display == "flex";
