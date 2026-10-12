import { firebaseConfig, EMAILS_PERMITIDOS } from './firebase-config.js';

// ?demo em localhost usa um Firebase falso em memória, para testar a interface.
const DEMO = new URLSearchParams(location.search).has('demo') && ['localhost', '127.0.0.1'].includes(location.hostname);
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const fb = DEMO
  ? await import('./demo.js')
  : Object.assign({}, ...await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]));
const {
  initializeApp, getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, where, addDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, arrayUnion, writeBatch,
} = fb;

// Receitas desligadas por enquanto: só gastos aparecem na interface.
const COM_RECEITAS = false;
// Sem separar quem pagou: os gastos são todos do casal.
const COM_PESSOAS = false;
document.body.classList.toggle('sem-receitas', !COM_RECEITAS);
document.body.classList.toggle('sem-pessoas', !COM_PESSOAS);

const PADRAO = {
  pessoas: ['Fernando', 'Esposa', 'Conta conjunta'],
  catGasto: ['Mercado', 'Bebê', 'Moradia', 'Contas da casa', 'Transporte', 'Saúde', 'Restaurante', 'Lazer',
    'Viagem', 'Compras', 'Roupas', 'Beleza', 'Presentes', 'Educação', 'Assinaturas', 'Pets', 'Outros'],
  catReceita: ['Salário', 'Freela', 'Rendimentos', 'Outros'],
};
const EMOJI = {
  mercado: '🛒', bebe: '👶', moradia: '🏠', aluguel: '🏠', 'contas da casa': '💡', contas: '💡', transporte: '🚗', carro: '🚗',
  saude: '💊', restaurante: '🍽️', delivery: '🛵', lazer: '🎉', viagem: '✈️', compras: '🛍️', roupas: '👕',
  educacao: '📚', assinaturas: '📺', pets: '🐾', presentes: '🎁', beleza: '💅', academia: '🏋️', filhos: '🧸',
  outros: '📦', salario: '💼', freela: '💻', rendimentos: '📈', investimentos: '📈', reembolso: '↩️',
};
const CORES = ['#0d9488', '#2563eb', '#d97706', '#e11d48', '#7c3aed', '#db2777', '#059669',
  '#0891b2', '#ca8a04', '#4f46e5', '#ea580c', '#64748b'];
const CORES_PESSOAS = ['#2563eb', '#db2777', '#0d9488', '#d97706', '#7c3aed'];

const estado = {
  user: null,
  mes: mesAtual(),
  aba: 'resumo',
  lancs: [],
  fixos: [],
  config: { ...PADRAO },
  orcamentos: {},
  filtro: { tipo: '', quem: '', categoria: '', busca: '' },
  unsubs: [],
  unsubLancs: null,
};

// ---------- utilitários ----------
function $(s) { return document.querySelector(s); }
function pad(n) { return String(n).padStart(2, '0'); }
function brl(v) { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normal(s) { return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim(); }
function emoji(cat) { return EMOJI[normal(cat)] || '🏷️'; }
function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function mesAtual() { return iso(new Date()).slice(0, 7); }
function hoje() { return iso(new Date()); }
function ontem() { const d = new Date(); d.setDate(d.getDate() - 1); return iso(d); }
function somaMes(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  return iso(new Date(a, m - 1 + n, 1)).slice(0, 7);
}
function diasNoMes(mes) { const [a, m] = mes.split('-').map(Number); return new Date(a, m, 0).getDate(); }
function nomeMes(mes, opts = { month: 'long', year: 'numeric' }) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', opts).replace(' de ', ' ');
}
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
function diaDaSemana(data) { return new Date(`${data}T12:00`).getDay(); }
function rotuloSemana(dow) { return `${dow === 0 || dow === 6 ? 'Todo' : 'Toda'} ${DIAS_SEMANA[dow]}`; }
function rotuloRepeticao(f) { return f.frequencia === 'semanal' ? rotuloSemana(f.diaSemana) : `Todo dia ${f.dia}`; }
// Quanto o fixo pesa por mês (semanais ≈ 52 semanas / 12 meses).
function valorMensal(f) { return f.frequencia === 'semanal' ? (f.valor * 52) / 12 : f.valor; }
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function parseValor(s) {
  s = String(s).trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}
function fmtCent(c) { return (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function somar(lista, campo) {
  const r = {};
  for (const l of lista) { const k = l[campo] || 'Outros'; r[k] = (r[k] || 0) + l.valor; }
  return r;
}
function totais(lista) {
  let receitas = 0, gastos = 0;
  for (const l of lista) l.tipo === 'receita' ? (receitas += l.valor) : (gastos += l.valor);
  return { receitas, gastos };
}
function corCategoria(cat) {
  const i = estado.config.catGasto.indexOf(cat);
  if (i >= 0) return CORES[i % CORES.length];
  let h = 0;
  for (const c of cat) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CORES[h % CORES.length];
}
function corPessoa(p) {
  const i = estado.config.pessoas.indexOf(p);
  return CORES_PESSOAS[(i >= 0 ? i : estado.config.pessoas.length) % CORES_PESSOAS.length];
}
function linhas(texto) { return [...new Set(texto.split('\n').map((s) => s.trim()).filter(Boolean))]; }
function lancsDoMes(mes) { return estado.lancs.filter((l) => l.mes === mes); }
function rotuloDia(data) {
  if (data === hoje()) return 'Hoje';
  if (data === ontem()) return 'Ontem';
  return cap(new Date(`${data}T12:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' }));
}
function lerLocal(k) { try { return localStorage.getItem(k); } catch { return null; } }
function gravarLocal(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } }

// ---------- Firebase ----------
const configurado = DEMO || !String(firebaseConfig.apiKey).startsWith('COLE');
let auth, db;
let mensagemLogin = '';

if (!configurado) {
  mostrarLogin();
  $('#login-msg').textContent = 'Falta colar a configuração do Firebase em firebase-config.js.';
  $('#btn-login').disabled = true;
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  onAuthStateChanged(auth, (user) => {
    pararListeners();
    if (!user) return mostrarLogin();
    const permitidos = EMAILS_PERMITIDOS.map((e) => e.toLowerCase());
    if (!DEMO && !permitidos.includes((user.email || '').toLowerCase())) {
      mensagemLogin = `A conta ${user.email} não tem acesso a este app.`;
      signOut(auth);
      return;
    }
    estado.user = user;
    mostrarApp();
    iniciarListeners();
  });
}

$('#btn-login').onclick = async () => {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      $('#login-msg').textContent = e.message;
    }
  }
};
$('#btn-sair').onclick = () => signOut(auth);

function mostrarLogin() {
  estado.user = null;
  $('#carregando').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#tela-login').classList.remove('hidden');
  $('#login-msg').textContent = mensagemLogin;
  mensagemLogin = '';
}
function mostrarApp() {
  $('#carregando').classList.add('hidden');
  $('#tela-login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#usuario-email').textContent = estado.user.email;
  renderTudo();
}

function pararListeners() {
  estado.unsubs.forEach((u) => u());
  estado.unsubs = [];
  estado.unsubLancs?.();
  estado.unsubLancs = null;
}

function iniciarListeners() {
  estado.unsubs.push(onSnapshot(doc(db, 'config', 'geral'), (s) => {
    const d = s.data() || {};
    estado.config = {
      pessoas: d.pessoas?.length ? d.pessoas : PADRAO.pessoas,
      catGasto: d.catGasto?.length ? d.catGasto : PADRAO.catGasto,
      catReceita: d.catReceita?.length ? d.catReceita : PADRAO.catReceita,
    };
    renderTudo();
    renderAjustes();
  }));
  estado.unsubs.push(onSnapshot(doc(db, 'config', 'orcamentos'), (s) => {
    estado.orcamentos = s.data()?.limites || {};
    renderResumo();
    renderAjustes();
  }));
  estado.unsubs.push(onSnapshot(collection(db, 'fixos'), (s) => {
    estado.fixos = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFixos();
    // Só gera a partir de dados confirmados pelo servidor, para não recriar algo já apagado.
    if (!s.metadata.fromCache) gerarFixos().catch(console.error);
  }));
  assinarLancamentos();
}

function assinarLancamentos() {
  estado.unsubLancs?.();
  const q = query(collection(db, 'lancamentos'), where('mes', 'in', [estado.mes, somaMes(estado.mes, -1)]));
  estado.unsubLancs = onSnapshot(q, (s) => {
    estado.lancs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderResumo();
    renderLancamentos();
  });
}

// Datas em que um fixo cai no mês. Mensais entram uma vez por mês (chave = mês);
// semanais entram só quando o dia chega (chave = data), a partir de quando foram criados.
function ocorrencias(f, mes) {
  if (f.frequencia !== 'semanal') return [{ chave: mes, data: `${mes}-${pad(Math.min(f.dia, diasNoMes(mes)))}` }];
  const limite = mes === mesAtual() ? hoje() : `${mes}-${pad(diasNoMes(mes))}`;
  const r = [];
  for (let d = 1; d <= diasNoMes(mes); d++) {
    const data = `${mes}-${pad(d)}`;
    if (data <= limite && data >= (f.inicioData || '') && diaDaSemana(data) === f.diaSemana) r.push({ chave: data, data });
  }
  return r;
}

// Cria, para o mês em exibição, os lançamentos dos fixos que ainda não foram gerados.
async function gerarFixos() {
  const mes = estado.mes;
  if (mes > mesAtual()) return;
  for (const f of estado.fixos) {
    if (f.ativo === false || mes < f.inicio) continue;
    const novas = ocorrencias(f, mes).filter((o) => !(f.gerados || []).includes(o.chave));
    if (!novas.length) continue;
    const b = writeBatch(db);
    for (const o of novas) {
      b.set(doc(db, 'lancamentos', `${f.id}_${o.chave}`), {
        tipo: f.tipo, valor: f.valor, categoria: f.categoria, descricao: f.descricao || '', quem: f.quem || '',
        data: o.data, mes, fixoId: f.id, criadoPor: 'automático', criadoEm: serverTimestamp(),
      });
    }
    b.update(doc(db, 'fixos', f.id), { gerados: arrayUnion(...novas.map((o) => o.chave)) });
    await b.commit();
  }
}

// Grava sem esperar o servidor (funciona offline) e só avisa se der erro.
function gravar(promessa) {
  promessa.catch((e) => alert(`Não foi possível salvar: ${e.message}`));
}

// ---------- navegação ----------
function irParaMes(mes) {
  if (mes === estado.mes) return;
  estado.mes = mes;
  estado.lancs = [];
  renderTudo();
  assinarLancamentos();
  gerarFixos().catch(console.error);
}
$('#mes-ant').onclick = () => irParaMes(somaMes(estado.mes, -1));
$('#mes-prox').onclick = () => irParaMes(somaMes(estado.mes, 1));
$('#mes-titulo').onclick = () => irParaMes(mesAtual());

const TITULOS = { fixos: 'Gastos fixos', ajustes: 'Ajustes' };
function irPara(aba) {
  estado.aba = aba;
  document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('ativo', x.dataset.aba === aba));
  document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('hidden', s.id !== `aba-${aba}`));
  const comMes = aba === 'resumo' || aba === 'lancamentos';
  $('#nav-mes').classList.toggle('hidden', !comMes);
  $('#titulo-aba').classList.toggle('hidden', comMes);
  $('#titulo-aba').textContent = TITULOS[aba] || '';
  $('#fab').classList.toggle('hidden', aba === 'ajustes');
  if (aba === 'ajustes') renderAjustes();
  if (aba === 'lancamentos') renderLancamentos();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach((b) => { b.onclick = () => irPara(b.dataset.aba); });
document.addEventListener('click', (e) => {
  const ir = e.target.closest('[data-ir]');
  if (ir) irPara(ir.dataset.ir);
});
$('#fab').onclick = () => abrirSheet(estado.aba === 'fixos' ? 'fixo' : 'lanc');

// ---------- renderização ----------
function renderTudo() {
  const titulo = cap(nomeMes(estado.mes));
  $('#mes-titulo').innerHTML = estado.mes === mesAtual() ? esc(titulo) : `${esc(titulo)}<small>voltar para hoje</small>`;
  renderResumo();
  renderLancamentos();
  renderFixos();
}

function itemHtml(l, extra = '') {
  const receita = l.tipo === 'receita';
  const cor = receita ? '#059669' : corCategoria(l.categoria);
  return `<li><button class="item" data-id="${l.id}" ${extra}>
    <span class="avatar" style="--c:${cor}">${emoji(l.categoria)}</span>
    <span class="info"><span class="titulo">${esc(l.descricao || l.categoria)}</span>
      <small>${detalhes(l.categoria, l.quem)}${l.fixoId ? ' · 🔁' : ''}${l.origem === 'whatsapp' ? ' · 💬' : ''}</small></span>
    <span class="valor ${receita ? 'pos' : ''}">${sinal(l)}${brl(l.valor)}</span>
  </button></li>`;
}
function detalhes(...partes) {
  return partes.slice(0, COM_PESSOAS ? partes.length : 1).filter(Boolean).map(esc).join(' · ');
}
function sinal(l) {
  if (l.tipo === 'receita') return '+ ';
  return COM_RECEITAS ? '− ' : '';
}

function renderResumo() {
  if (!estado.user) return;
  const mesAnt = somaMes(estado.mes, -1);
  const atual = lancsDoMes(estado.mes);
  const anterior = lancsDoMes(mesAnt);
  const t = totais(atual);
  const ta = totais(anterior);
  const saldo = t.receitas - t.gastos;
  const ehAtual = estado.mes === mesAtual();

  const diasCorridos = ehAtual ? new Date().getDate() : estado.mes < mesAtual() ? diasNoMes(estado.mes) : 1;
  if (COM_RECEITAS) {
    $('#hero-rotulo').textContent = `Saldo de ${nomeMes(estado.mes, { month: 'long' })}`;
    $('#hero-saldo').textContent = brl(saldo);
    $('#hero-saldo').classList.toggle('negativo', saldo < 0);
    $('#hero-l1').textContent = '↑ Receitas';
    $('#hero-receitas').textContent = brl(t.receitas);
    $('#hero-l2').textContent = '↓ Gastos';
    $('#hero-gastos').textContent = brl(t.gastos);
  } else {
    $('#hero-rotulo').textContent = `Gastos de ${nomeMes(estado.mes, { month: 'long' })}`;
    $('#hero-saldo').textContent = brl(t.gastos);
    $('#hero-l1').textContent = cap(nomeMes(mesAnt, { month: 'long' }));
    $('#hero-receitas').textContent = brl(ta.gastos);
    $('#hero-l2').textContent = 'Média por dia';
    $('#hero-gastos').textContent = brl(t.gastos / diasCorridos);
  }

  // Destaques rápidos
  const ins = [];
  if (ta.gastos > 0 && t.gastos > 0) {
    const v = ((t.gastos - ta.gastos) / ta.gastos) * 100;
    ins.push(`<span class="insight ${v <= 0 ? 'bom' : 'ruim'}">${v <= 0 ? '▼' : '▲'} ${Math.abs(v).toFixed(0)}% de gastos vs ${nomeMes(mesAnt, { month: 'short' }).replace('.', '')}</span>`);
  }
  if (COM_RECEITAS && t.gastos > 0) ins.push(`<span class="insight">≈ ${brl(t.gastos / diasCorridos)} por dia</span>`);
  $('#insights').innerHTML = ins.join('');

  // Orçamento total
  const gastos = atual.filter((l) => l.tipo === 'gasto');
  const porCat = somar(gastos, 'categoria');
  const limites = Object.entries(estado.orcamentos).filter(([, v]) => v > 0);
  const painelOrc = $('#painel-orc');
  if (limites.length) {
    const totalLim = limites.reduce((s, [, v]) => s + v, 0);
    const usado = limites.reduce((s, [c]) => s + (porCat[c] || 0), 0);
    const pct = (usado / totalLim) * 100;
    const resta = totalLim - usado;
    let sub;
    if (resta < 0) sub = `Passou <b class="neg">${brl(-resta)}</b> do planejado`;
    else if (ehAtual) {
      const diasRest = diasNoMes(estado.mes) - new Date().getDate() + 1;
      sub = `Restam <b>${brl(resta)}</b> · dá para gastar <b>${brl(resta / diasRest)}</b> por dia`;
    } else sub = `Sobrou <b>${brl(resta)}</b> do planejado`;
    painelOrc.innerHTML = `
      <div class="painel-cab"><h2>Orçamento do mês</h2><span class="muted">${pct.toFixed(0)}%</span></div>
      <div class="orc-total"><b>${brl(usado)}</b><span class="muted"> de ${brl(totalLim)}</span></div>
      <div class="barra grossa ${pct > 100 ? 'estourou' : pct > 85 ? 'alerta' : ''}"><div style="width:${Math.min(pct, 100)}%"></div></div>
      <p class="orc-sub">${sub}</p>`;
  } else {
    painelOrc.innerHTML = `
      <div class="cta"><span class="cta-emoji">🎯</span><div><b>Defina um orçamento</b>
      <small class="muted">Escolha um limite por categoria e acompanhe quanto ainda dá para gastar.</small></div>
      <button class="btn pequeno" data-ir="ajustes">Definir</button></div>`;
  }

  // Por categoria
  const cats = [...new Set([...Object.keys(porCat), ...limites.map(([c]) => c)])]
    .sort((a, b) => (porCat[b] || 0) - (porCat[a] || 0));
  if (!gastos.length && !cats.length) {
    $('#cat-conteudo').innerHTML = '<p class="vazio">Nenhum gasto neste mês ainda.</p>';
  } else {
    let acc = 0;
    const fatias = cats.filter((c) => porCat[c] > 0).map((c) => {
      const ini = acc;
      acc += (porCat[c] / t.gastos) * 100;
      return `${corCategoria(c)} ${ini}% ${acc}%`;
    });
    $('#cat-conteudo').innerHTML = `
      ${t.gastos > 0 ? `<div class="rosca" style="background:conic-gradient(${fatias.join(',')})">
        <div><small>Total gasto</small><b>${brl(t.gastos)}</b></div></div>` : ''}
      <ul class="lista-cat ${estado.catsAbertas || cats.length <= 6 ? '' : 'recolhida'}">${cats.map((c) => {
        const g = porCat[c] || 0;
        const lim = estado.orcamentos[c] || 0;
        const pct = lim ? (g / lim) * 100 : 0;
        const classe = pct > 100 ? 'estourou' : pct > 85 ? 'alerta' : '';
        return `<li><button class="cat-linha" data-cat="${esc(c)}">
          <span class="avatar pequeno" style="--c:${corCategoria(c)}">${emoji(c)}</span>
          <span class="cat-info">
            <span class="linha"><span>${esc(c)}</span><b>${brl(g)}</b></span>
            ${lim ? `<span class="barra ${classe}"><span style="width:${Math.min(pct, 100)}%"></span></span>
              <small class="muted">${g <= lim ? `restam ${brl(lim - g)} de ${brl(lim)}` : `passou ${brl(g - lim)} do limite de ${brl(lim)}`}</small>`
              : `<small class="muted">${t.gastos ? ((g / t.gastos) * 100).toFixed(0) : 0}% dos gastos</small>`}
          </span></button></li>`;
      }).join('')}</ul>
      ${cats.length > 6 ? `<button class="link centro" id="ver-cats">${estado.catsAbertas ? 'Mostrar menos' : `Mostrar todas (${cats.length})`}</button>` : ''}`;
  }

  // Quem pagou
  const porPessoa = Object.entries(somar(gastos, 'quem')).sort((a, b) => b[1] - a[1]);
  $('#pessoas-conteudo').innerHTML = porPessoa.length ? `
    <div class="barra-empilhada">${porPessoa.map(([p, v]) => `<span style="flex:${v};background:${corPessoa(p)}"></span>`).join('')}</div>
    <ul class="legenda">${porPessoa.map(([p, v]) => `<li><i style="background:${corPessoa(p)}"></i><span>${esc(p)}</span>
      <b>${brl(v)}</b><small class="muted">${((v / t.gastos) * 100).toFixed(0)}%</small></li>`).join('')}</ul>`
    : '<p class="vazio">Nada por aqui ainda.</p>';

  // Últimos
  const ultimos = [...atual].sort(ordemRecente).slice(0, 5);
  $('#ultimos').innerHTML = ultimos.map((l) => itemHtml(l)).join('')
    || '<li class="vazio">Toque em <b>+</b> para lançar o primeiro gasto do mês.</li>';
}
function ordemRecente(a, b) {
  return b.data.localeCompare(a.data) || (b.criadoEm?.seconds || 0) - (a.criadoEm?.seconds || 0);
}

$('#cat-conteudo').onclick = (e) => {
  if (e.target.closest('#ver-cats')) {
    estado.catsAbertas = !estado.catsAbertas;
    renderResumo();
    return;
  }
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  estado.filtro = { tipo: 'gasto', quem: '', categoria: b.dataset.cat, busca: '' };
  $('#busca').value = '';
  irPara('lancamentos');
};
$('#ultimos').onclick = abrirItemDaLista;

function renderLancamentos() {
  if (!estado.user) return;
  const f = estado.filtro;
  const chip = (rot, ativo, attrs) => `<button type="button" class="chip ${ativo ? 'ativo' : ''}" ${attrs}>${rot}</button>`;
  $('#chips-filtro').innerHTML = (f.categoria ? chip(`${emoji(f.categoria)} ${esc(f.categoria)} ✕`, true, 'data-limpar-cat') : '')
    + (COM_RECEITAS ? chip('Todos', !f.tipo, 'data-tipo=""') + chip('Gastos', f.tipo === 'gasto', 'data-tipo="gasto"')
      + chip('Receitas', f.tipo === 'receita', 'data-tipo="receita"') + '<span class="sep"></span>' : '')
    + (COM_PESSOAS ? estado.config.pessoas.map((p) => chip(esc(p), f.quem === p, `data-quem="${esc(p)}"`)).join('') : '');

  const busca = normal(f.busca);
  const lista = lancsDoMes(estado.mes)
    .filter((l) => (!f.tipo || l.tipo === f.tipo) && (!f.categoria || l.categoria === f.categoria) && (!f.quem || l.quem === f.quem))
    .filter((l) => !busca || normal(`${l.descricao} ${l.categoria} ${l.quem}`).includes(busca))
    .sort(ordemRecente);

  const t = totais(lista);
  $('#total-filtro').innerHTML = lista.length ? `<span>${lista.length} lançamento${lista.length > 1 ? 's' : ''}</span>
    <span>${t.gastos ? `<b class="neg">${COM_RECEITAS ? '− ' : ''}${brl(t.gastos)}</b>` : ''}${t.receitas ? ` <b class="pos">+ ${brl(t.receitas)}</b>` : ''}</span>` : '';

  const grupos = {};
  for (const l of lista) (grupos[l.data] ||= []).push(l);
  const filtrando = f.tipo || f.quem || f.categoria || busca;
  $('#lista-lanc').innerHTML = Object.entries(grupos).map(([data, itens]) => {
    const g = totais(itens).gastos;
    return `<div class="dia-cab"><span>${rotuloDia(data)}</span>${g ? `<span>${COM_RECEITAS ? '− ' : ''}${brl(g)}</span>` : ''}</div>
      <ul class="itens">${itens.map((l) => itemHtml(l)).join('')}</ul>`;
  }).join('') || `<div class="vazio grande"><span>${filtrando ? '🔍' : '🧾'}</span>
    ${filtrando ? 'Nenhum lançamento com esses filtros.' : 'Nenhum lançamento neste mês.<br>Toque em <b>+</b> para adicionar.'}</div>`;
}
$('#chips-filtro').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const f = estado.filtro;
  if (b.hasAttribute('data-limpar-cat')) f.categoria = '';
  else if (b.dataset.tipo !== undefined) f.tipo = b.dataset.tipo;
  else if (b.dataset.quem !== undefined) f.quem = f.quem === b.dataset.quem ? '' : b.dataset.quem;
  renderLancamentos();
};
$('#busca').oninput = (e) => { estado.filtro.busca = e.target.value; renderLancamentos(); };
$('#lista-lanc').onclick = abrirItemDaLista;
function abrirItemDaLista(e) {
  const b = e.target.closest('[data-id]');
  if (b) abrirSheet('lanc', estado.lancs.find((l) => l.id === b.dataset.id));
}

function renderFixos() {
  if (!estado.user) return;
  const ativos = estado.fixos.filter((f) => f.ativo !== false);
  const t = totais(ativos.map((f) => ({ ...f, valor: valorMensal(f) })));
  const aprox = ativos.some((f) => f.frequencia === 'semanal') ? '≈ ' : '';
  $('#fixo-receitas').textContent = brl(t.receitas);
  $('#fixo-gastos').textContent = aprox + brl(t.gastos);
  $('#fixo-sobra').textContent = brl(t.receitas - t.gastos);
  $('#fixo-sobra').className = t.receitas - t.gastos < 0 ? 'neg' : '';

  const grupo = (tipo, titulo) => {
    const ordem = (f) => (f.frequencia === 'semanal' ? 100 + ((f.diaSemana + 6) % 7) : f.dia);
    const itens = estado.fixos.filter((f) => f.tipo === tipo).sort((a, b) => ordem(a) - ordem(b));
    if (!itens.length) return '';
    return `${titulo ? `<div class="dia-cab"><span>${titulo}</span></div>` : ''}<ul class="itens">${itens.map((f) => {
      const receita = f.tipo === 'receita';
      return `<li><button class="item ${f.ativo === false ? 'inativo' : ''}" data-id="${f.id}">
        <span class="avatar" style="--c:${receita ? '#059669' : corCategoria(f.categoria)}">${emoji(f.categoria)}</span>
        <span class="info"><span class="titulo">${esc(f.descricao || f.categoria)}</span>
          <small>${rotuloRepeticao(f)} · ${detalhes(f.categoria, f.quem)}${f.ativo === false ? ' · pausado' : ''}</small></span>
        <span class="valor ${receita ? 'pos' : ''}">${sinal(f)}${brl(f.valor)}</span>
      </button></li>`;
    }).join('')}</ul>`;
  };
  $('#lista-fixos').innerHTML = (COM_RECEITAS ? grupo('receita', 'Receitas') + grupo('gasto', 'Gastos') : grupo('gasto', ''))
    || '<div class="vazio grande"><span>🔁</span>Nenhum fixo ainda.<br>Toque em <b>+</b> para cadastrar salário, aluguel, luz…</div>';
}
$('#lista-fixos').onclick = (e) => {
  const b = e.target.closest('[data-id]');
  if (b) abrirSheet('fixo', estado.fixos.find((f) => f.id === b.dataset.id));
};

function renderAjustes() {
  if (!estado.user || $('#aba-ajustes').contains(document.activeElement)) return;
  $('#cfg-pessoas').value = estado.config.pessoas.join('\n');
  $('#cfg-cat-gasto').value = estado.config.catGasto.join('\n');
  $('#cfg-cat-receita').value = estado.config.catReceita.join('\n');
  $('#orc-campos').innerHTML = estado.config.catGasto.map((c) => `
    <label class="orc"><span class="avatar pequeno" style="--c:${corCategoria(c)}">${emoji(c)}</span><span class="orc-nome">${esc(c)}</span>
      <span class="orc-input"><small>R$</small><input data-cat="${esc(c)}" inputmode="decimal" placeholder="—"
        value="${estado.orcamentos[c] ? fmtCent(Math.round(estado.orcamentos[c] * 100)) : ''}"></span></label>`).join('');
}

$('#salvar-config').onclick = () => {
  const novo = {
    pessoas: linhas($('#cfg-pessoas').value),
    catGasto: linhas($('#cfg-cat-gasto').value),
    catReceita: linhas($('#cfg-cat-receita').value),
  };
  if ((COM_PESSOAS && !novo.pessoas.length) || !novo.catGasto.length || (COM_RECEITAS && !novo.catReceita.length)) {
    alert('Cada lista precisa ter pelo menos um item.');
    return;
  }
  document.activeElement?.blur();
  gravar(setDoc(doc(db, 'config', 'geral'), novo));
  toast('Ajustes salvos');
};
$('#salvar-orc').onclick = () => {
  const limites = {};
  for (const inp of document.querySelectorAll('#orc-campos input')) {
    const v = parseValor(inp.value);
    if (inp.value.trim() && v > 0) limites[inp.dataset.cat] = v;
  }
  document.activeElement?.blur();
  gravar(setDoc(doc(db, 'config', 'orcamentos'), { limites }));
  toast('Orçamento salvo');
};

function toast(msg, acao) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (acao) {
    const b = document.createElement('button');
    b.textContent = acao.rotulo;
    b.onclick = () => { acao.fn(); t.remove(); };
    t.append(b);
  }
  document.body.append(t);
  setTimeout(() => t.remove(), acao ? 6000 : 2500);
}

// ---------- folha de lançamento ----------
const sheet = $('#sheet');
const form = $('#form-item');
const inpValor = $('#valor');
let edicao = null;
// rep: repetição escolhida ao lançar ('' | 'semanal' | 'mensal'); freq/dow: frequência de um fixo.
const sel = { tipo: 'gasto', categoria: '', quem: '', centavos: 0, rep: '', freq: 'mensal', dow: 5 };

function pessoaPadrao() {
  const ultima = lerLocal('ultimaPessoa');
  if (ultima && estado.config.pessoas.includes(ultima)) return ultima;
  const primeiroNome = normal((estado.user?.displayName || '').split(' ')[0]);
  return estado.config.pessoas.find((p) => normal(p) === primeiroNome) || estado.config.pessoas[0];
}

function abrirSheet(modo, item) {
  edicao = { modo, item: item || null };
  sel.tipo = item?.tipo || 'gasto';
  sel.categoria = item?.categoria || '';
  sel.quem = item?.quem || pessoaPadrao();
  sel.centavos = item ? Math.round(item.valor * 100) : 0;
  mostrarValor();
  form.descricao.value = item?.descricao || '';
  form.data.value = item?.data || (estado.mes === mesAtual() ? hoje() : `${estado.mes}-01`);
  form.dia.value = item?.dia || new Date().getDate();
  form.ativo.checked = item ? item.ativo !== false : true;
  sel.rep = '';
  sel.freq = modo === 'fixo' && item?.frequencia === 'semanal' ? 'semanal' : 'mensal';
  sel.dow = item?.diaSemana ?? new Date().getDay();

  $('#campo-data').hidden = modo !== 'lanc';
  $('#campo-freq').hidden = modo !== 'fixo';
  $('#campo-repetir').hidden = modo !== 'lanc' || !!item;
  $('#campo-ativo').hidden = modo !== 'fixo' || !item;
  $('#btn-excluir').style.visibility = item ? 'visible' : 'hidden';
  $('#sheet-titulo').textContent = modo === 'fixo'
    ? (item ? 'Editar gasto fixo' : 'Novo gasto fixo')
    : (item ? 'Editar lançamento' : COM_RECEITAS ? 'Novo lançamento' : 'Novo gasto');
  $('#aviso').textContent = modo === 'lanc' && item?.fixoId
    ? 'Gerado por um gasto fixo. Alterar aqui muda só este lançamento.'
    : modo === 'fixo' && item ? 'Alterações valem a partir do próximo lançamento gerado.' : '';
  $('#btn-salvar').textContent = item ? 'Salvar alterações' : modo === 'fixo' ? 'Adicionar fixo' : 'Adicionar';
  renderSheet();
  sheet.showModal();
  sheet.scrollTop = 0;
  if (!item) requestAnimationFrame(() => { inpValor.focus(); inpValor.setSelectionRange(99, 99); });
  else inpValor.blur();
}

function renderSheet() {
  form.querySelector(`input[name=tipo][value=${sel.tipo}]`).checked = true;
  sheet.dataset.tipo = sel.tipo;
  const lista = sel.tipo === 'receita' ? estado.config.catReceita : estado.config.catGasto;
  const cats = sel.categoria && !lista.includes(sel.categoria) ? [...lista, sel.categoria] : lista;
  $('#cats').innerHTML = cats.map((c) => `<button type="button" class="cat ${c === sel.categoria ? 'ativo' : ''}"
    data-cat="${esc(c)}" style="--c:${sel.tipo === 'receita' ? '#059669' : corCategoria(c)}" aria-pressed="${c === sel.categoria}">
    <span>${emoji(c)}</span>${esc(c)}</button>`).join('');
  const pessoas = estado.config.pessoas.includes(sel.quem) ? estado.config.pessoas : [...estado.config.pessoas, sel.quem];
  $('#pessoas').innerHTML = pessoas.map((p) => `<button type="button" class="chip ${p === sel.quem ? 'ativo' : ''}"
    data-quem="${esc(p)}" aria-pressed="${p === sel.quem}">${esc(p)}</button>`).join('');
  const d = form.data.value;
  const outra = d && d !== hoje() && d !== ontem();
  sheet.querySelector('[data-quando=hoje]').classList.toggle('ativo', d === hoje());
  sheet.querySelector('[data-quando=ontem]').classList.toggle('ativo', d === ontem());
  $('#chip-data').classList.toggle('ativo', !!outra);

  // Repetir (ao lançar): os rótulos acompanham a data escolhida.
  const base = d || hoje();
  const opcoesRep = [['', 'Não'], ['semanal', rotuloSemana(diaDaSemana(base))], ['mensal', `Todo dia ${Number(base.slice(8))}`]];
  $('#chips-repetir').innerHTML = opcoesRep.map(([v, rot]) => `<button type="button" class="chip ${sel.rep === v ? 'ativo' : ''}"
    data-rep="${v}" aria-pressed="${sel.rep === v}">${rot}</button>`).join('');

  // Frequência (fixo)
  sheet.querySelectorAll('[data-freq]').forEach((b) => b.classList.toggle('ativo', b.dataset.freq === sel.freq));
  $('#campo-dia').hidden = sel.freq !== 'mensal';
  $('#campo-semana').hidden = sel.freq !== 'semanal';
  $('#campo-semana').innerHTML = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((n, i) => `<button type="button"
    class="chip ${sel.dow === i ? 'ativo' : ''}" data-dow="${i}" aria-pressed="${sel.dow === i}">${n}</button>`).join('');
}
$('#chips-repetir').onclick = (e) => {
  const b = e.target.closest('[data-rep]');
  if (!b) return;
  sel.rep = b.dataset.rep;
  renderSheet();
};
$('#chips-freq').onclick = (e) => {
  const b = e.target.closest('[data-freq]');
  if (!b) return;
  sel.freq = b.dataset.freq;
  renderSheet();
};
$('#campo-semana').onclick = (e) => {
  const b = e.target.closest('[data-dow]');
  if (!b) return;
  sel.dow = Number(b.dataset.dow);
  renderSheet();
};

function mostrarValor() {
  inpValor.value = fmtCent(sel.centavos);
  inpValor.style.width = `${inpValor.value.length * 0.62 + 0.3}em`;
}
inpValor.addEventListener('input', () => {
  const digitos = inpValor.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 10);
  sel.centavos = parseInt(digitos || '0', 10);
  mostrarValor();
  inpValor.setSelectionRange(99, 99);
});
inpValor.addEventListener('focus', () => setTimeout(() => inpValor.setSelectionRange(99, 99)));

form.querySelectorAll('input[name=tipo]').forEach((r) => {
  r.onchange = () => {
    sel.tipo = r.value;
    const lista = sel.tipo === 'receita' ? estado.config.catReceita : estado.config.catGasto;
    if (!lista.includes(sel.categoria)) sel.categoria = '';
    renderSheet();
  };
});
$('#cats').onclick = (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  sel.categoria = b.dataset.cat;
  $('#cats').closest('.campo').classList.remove('erro-campo');
  renderSheet();
};
$('#pessoas').onclick = (e) => {
  const b = e.target.closest('[data-quem]');
  if (!b) return;
  sel.quem = b.dataset.quem;
  renderSheet();
};
sheet.querySelectorAll('[data-quando]').forEach((b) => {
  b.onclick = () => { form.data.value = b.dataset.quando === 'hoje' ? hoje() : ontem(); renderSheet(); };
});
form.data.onchange = renderSheet;

$('#btn-fechar').onclick = () => sheet.close();
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

function marcarErro(el) {
  el.classList.remove('erro-campo');
  void el.offsetWidth;
  el.classList.add('erro-campo');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

$('#btn-excluir').onclick = () => {
  const { modo, item } = edicao;
  const colecao = modo === 'fixo' ? 'fixos' : 'lancamentos';
  const { id, ...dados } = item;
  sheet.close();
  gravar(deleteDoc(doc(db, colecao, id)));
  toast(modo === 'fixo' ? 'Fixo excluído' : 'Lançamento excluído', {
    rotulo: 'Desfazer',
    fn: () => gravar(setDoc(doc(db, colecao, id), dados)),
  });
};

form.onsubmit = (e) => {
  e.preventDefault();
  if (!sel.centavos) return marcarErro($('#valor-wrap'));
  if (!sel.categoria) return marcarErro($('#cats').closest('.campo'));
  const { modo, item } = edicao;
  if (modo === 'lanc' && !form.data.value) return marcarErro($('#campo-data'));

  const base = {
    tipo: sel.tipo,
    valor: sel.centavos / 100,
    categoria: sel.categoria,
    descricao: form.descricao.value.trim(),
    quem: COM_PESSOAS ? sel.quem : (edicao.item?.quem || ''),
  };
  gravarLocal('ultimaPessoa', base.quem);
  sheet.close();
  const nome = base.tipo === 'receita' ? 'Receita' : 'Gasto';

  if (modo === 'lanc') {
    const data = form.data.value;
    const mes = data.slice(0, 7);
    if (sel.rep) {
      // O próprio fixo gera o lançamento desta data.
      const repeticao = sel.rep === 'semanal'
        ? { frequencia: 'semanal', diaSemana: diaDaSemana(data) }
        : { frequencia: 'mensal', dia: Number(data.slice(8)) };
      gravar(addDoc(collection(db, 'fixos'), {
        ...base, ...repeticao, ativo: true, inicio: mes, inicioData: data, gerados: [],
        criadoPor: estado.user.email, criadoEm: serverTimestamp(),
      }));
      toast(`${nome} fixo criado: ${rotuloRepeticao(repeticao).toLowerCase()}`);
    } else if (item) {
      gravar(updateDoc(doc(db, 'lancamentos', item.id), { ...base, data, mes }));
      toast('Alterações salvas');
    } else {
      gravar(addDoc(collection(db, 'lancamentos'), {
        ...base, data, mes, criadoPor: estado.user.email, criadoEm: serverTimestamp(),
      }));
      toast(`${nome} de ${brl(base.valor)} adicionad${base.tipo === 'receita' ? 'a' : 'o'}`);
    }
    irParaMes(mes);
  } else {
    const dados = { ...base, frequencia: sel.freq, ativo: form.ativo.checked };
    if (sel.freq === 'semanal') {
      dados.diaSemana = sel.dow;
      dados.inicioData = item?.inicioData || hoje();
    } else {
      dados.dia = Math.min(31, Math.max(1, parseInt(form.dia.value, 10) || 1));
    }
    if (item) {
      gravar(updateDoc(doc(db, 'fixos', item.id), dados));
      toast('Fixo atualizado');
    } else {
      gravar(addDoc(collection(db, 'fixos'), {
        ...dados, inicio: mesAtual(), inicioData: hoje(), gerados: [],
        criadoPor: estado.user.email, criadoEm: serverTimestamp(),
      }));
      toast(`${nome} fixo adicionado`);
    }
  }
};

// ---------- PWA ----------
if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
