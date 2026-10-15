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
  serverTimestamp, arrayUnion, arrayRemove, writeBatch, getDocs,
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
  ano: new Date().getFullYear(),
  periodo: 'mes', // período do Resumo: 'mes' | 'ano' | 'tudo'
  catAberta: null, // categoria expandida no Resumo
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
// Lançamentos de fixos com valor variável que ainda esperam o valor real da conta.
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
    renderResumo();
    // Só gera a partir de dados confirmados pelo servidor, para não recriar algo já apagado.
    if (!s.metadata.fromCache) gerarFixos().catch(console.error);
  }));
  assinarLancamentos();
}

// Escuta todos os lançamentos (são poucos por mês): o resumo compara meses, anos e o acumulado.
function assinarLancamentos() {
  estado.unsubLancs?.();
  estado.unsubLancs = onSnapshot(collection(db, 'lancamentos'), (s) => {
    estado.lancs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderResumo();
    renderLancamentos();
    renderFixos();
  });
}

// Datas em que um fixo cai no mês, a partir do primeiro débito depois de criado (inicioData).
// Mensais: uma por mês (chave = mês). Semanais: uma por semana (chave = data).
function ocorrencias(f, mes) {
  if (f.frequencia !== 'semanal') {
    const data = `${mes}-${pad(Math.min(f.dia, diasNoMes(mes)))}`;
    return data >= (f.inicioData || '') ? [{ chave: mes, data }] : [];
  }
  const r = [];
  for (let d = 1; d <= diasNoMes(mes); d++) {
    const data = `${mes}-${pad(d)}`;
    if (data >= (f.inicioData || '') && diaDaSemana(data) === f.diaSemana) r.push({ chave: data, data });
  }
  return r;
}

// Apaga os lançamentos de um fixo que ainda não venceram (e que ninguém editou à mão) e libera as
// chaves para serem gerados de novo. Usado ao editar, pausar ou excluir o fixo. Devolve o que apagou.
async function limparFuturos(fixoId, manterFixo = true) {
  const snap = await getDocs(query(collection(db, 'lancamentos'), where('fixoId', '==', fixoId)));
  const futuros = snap.docs.filter((d) => d.data().data > hoje() && !d.data().confirmado);
  if (!futuros.length) return [];
  const b = writeBatch(db);
  futuros.forEach((d) => b.delete(d.ref));
  if (manterFixo) b.update(doc(db, 'fixos', fixoId), { gerados: arrayRemove(...futuros.map((d) => d.id.slice(fixoId.length + 1))) });
  await b.commit();
  return futuros.map((d) => ({ id: d.id, ...d.data() }));
}

// Cria, para o mês em exibição, os lançamentos dos fixos que já venceram e ainda não foram gerados.
// Cada fixo entra só no dia em que debita, nunca antes.
async function gerarFixos() {
  const mes = estado.mes;
  if (mes > mesAtual()) return;
  for (const f of estado.fixos) {
    if (f.ativo === false || mes < f.inicio) continue;
    const novas = ocorrencias(f, mes).filter((o) => o.data <= hoje() && !(f.gerados || []).includes(o.chave));
    if (!novas.length) continue;
    const b = writeBatch(db);
    for (const o of novas) {
      b.set(doc(db, 'lancamentos', `${f.id}_${o.chave}`), {
        tipo: f.tipo, valor: f.valor, categoria: f.categoria, descricao: f.descricao || '', quem: f.quem || '',
        data: o.data, mes, fixoId: f.id, confirmado: false, criadoPor: 'automático', criadoEm: serverTimestamp(),
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
  estado.catAberta = null;
  renderTudo();
  gerarFixos().catch(console.error);
}
// No Resumo as setas andam pelo período escolhido (mês ou ano); nas outras abas, sempre por mês.
function periodoVisivel() { return estado.aba === 'resumo' ? estado.periodo : 'mes'; }
function navegar(n) {
  if (periodoVisivel() === 'ano') {
    estado.ano += n;
    estado.catAberta = null;
    renderTudo();
  } else irParaMes(somaMes(estado.mes, n));
}
$('#mes-ant').onclick = () => navegar(-1);
$('#mes-prox').onclick = () => navegar(1);
$('#mes-titulo').onclick = () => {
  estado.ano = new Date().getFullYear();
  if (estado.mes === mesAtual()) renderTudo();
  else irParaMes(mesAtual());
};
function renderCabecalho() {
  const p = periodoVisivel();
  let titulo = 'Todo o período';
  let voltar = false;
  if (p === 'mes') {
    titulo = cap(nomeMes(estado.mes));
    voltar = estado.mes !== mesAtual();
  } else if (p === 'ano') {
    titulo = String(estado.ano);
    voltar = estado.ano !== new Date().getFullYear();
  }
  $('#mes-titulo').innerHTML = esc(titulo) + (voltar ? '<small>voltar para hoje</small>' : '');
  $('#mes-ant').style.visibility = p === 'tudo' ? 'hidden' : 'visible';
  $('#mes-prox').style.visibility = p === 'tudo' ? 'hidden' : 'visible';
}

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
  renderCabecalho();
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
  renderCabecalho();
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
      <small>${detalhes(l.categoria, l.quem)}${l.fixoId ? ' · 🔁' : ''}${['whatsapp', 'telegram'].includes(l.origem) ? ' · 💬' : ''}</small></span>
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

// ---------- resumo ----------
// O Resumo olha só os gastos (receitas estão desligadas) do período escolhido: um mês, um ano ou tudo.
function mesCurto(mes) { return nomeMes(mes, { month: 'short' }).replace('.', ''); }
function compacto(v) {
  if (v < 1000) return String(Math.round(v));
  return `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10000 ? 0 : 1 })}k`;
}
function dataCurta(data) {
  const ano = data.slice(0, 4) === String(new Date().getFullYear()) ? '' : `/${data.slice(2, 4)}`;
  return `${data.slice(8)}/${data.slice(5, 7)}${ano}`;
}
function gastosDe(lista) { return lista.filter((l) => l.tipo === 'gasto'); }
function soma(lista) { return lista.reduce((s, l) => s + l.valor, 0); }

// Meses cobertos pelo período (no Ano e no Tudo, só até o mês atual).
function mesesDoPeriodo() {
  if (estado.periodo === 'mes') return [estado.mes];
  const atual = mesAtual();
  if (estado.periodo === 'ano') {
    const r = [];
    for (let m = 1; m <= 12; m++) if (`${estado.ano}-${pad(m)}` <= atual) r.push(`${estado.ano}-${pad(m)}`);
    return r.length ? r : [`${estado.ano}-01`];
  }
  const primeiro = estado.lancs.reduce((min, l) => (l.mes < min ? l.mes : min), atual);
  const r = [];
  for (let m = primeiro; m <= atual; m = somaMes(m, 1)) r.push(m);
  return r;
}
// Lançamentos de fixo com data futura sobraram da versão que lançava o mês inteiro de uma vez: não contam.
function contaNoTotal(l) { return !(l.fixoId && l.data > hoje()); }
function gastosDoPeriodo(meses) {
  const set = new Set(meses);
  return gastosDe(estado.lancs.filter((l) => set.has(l.mes) && contaNoTotal(l)));
}

function renderResumo() {
  if (!estado.user) return;
  document.querySelectorAll('#seg-periodo button').forEach((b) => b.classList.toggle('ativo', b.dataset.periodo === estado.periodo));
  const meses = mesesDoPeriodo();
  const gastos = gastosDoPeriodo(meses);
  const total = soma(gastos);
  renderHero(gastos, total, meses);
  renderUltimos(gastos);
  renderCategorias(gastos, total, meses);
  renderEvolucao();
  renderPessoas(gastos, total);
}

function renderHero(gastos, total, meses) {
  const preencher = (rotulo, l1, v1, l2, v2) => {
    $('#hero-rotulo').textContent = rotulo;
    $('#hero-saldo').textContent = brl(total);
    $('#hero-l1').textContent = l1;
    $('#hero-receitas').textContent = v1;
    $('#hero-l2').textContent = l2;
    $('#hero-gastos').textContent = v2;
  };
  if (estado.periodo === 'mes') {
    const nome = nomeMes(estado.mes, { month: 'long' });
    const mesAnt = somaMes(estado.mes, -1);
    const dias = estado.mes === mesAtual() ? new Date().getDate() : estado.mes < mesAtual() ? diasNoMes(estado.mes) : 1;
    return preencher(`Gastos de ${nome}`, cap(nomeMes(mesAnt, { month: 'long' })), brl(soma(gastosDoPeriodo([mesAnt]))),
      'Média por dia', brl(total / dias));
  }
  const [mesTop, vTop] = Object.entries(somar(gastos, 'mes')).sort((a, b) => b[1] - a[1])[0] || [];
  const rotulo = estado.periodo === 'ano' ? `Gastos em ${estado.ano}` : `Gastos desde ${mesCurto(meses[0])} de ${meses[0].slice(0, 4)}`;
  preencher(rotulo, `Média por mês (${meses.length})`, brl(total / meses.length),
    'Mês mais caro', mesTop ? `${cap(mesCurto(mesTop))} · ${brl(vTop)}` : '—');
}

// Barra do limite da categoria: amarela perto do limite, vermelha quando passa.
function barraOrc(pct) {
  const classe = pct > 100 ? 'estourou' : pct > 85 ? 'alerta' : '';
  return `<span class="barra ${classe}"><span style="width:${Math.min(pct, 100)}%"></span></span>`;
}

function renderCategorias(gastos, total, meses) {
  const n = meses.length;
  const porCat = somar(gastos, 'categoria');
  const limites = Object.entries(estado.orcamentos).filter(([, v]) => v > 0);
  $('#cat-sub').textContent = n > 1 ? `${n} meses` : '';

  // Sem nenhum limite ainda, um convite para definir; o limite do período é o mensal × número de meses.
  const orc = !limites.length && estado.periodo === 'mes' ? `<div class="cta"><span class="cta-emoji">🎯</span><div><b>Defina limites</b>
      <small class="muted">Escolha um limite por categoria e veja quanto falta para chegar nele.</small></div>
      <button class="btn pequeno" data-ir="ajustes">Definir</button></div>` : '';

  const cats = [...new Set([...Object.keys(porCat), ...limites.map(([c]) => c)])]
    .sort((a, b) => (porCat[b] || 0) - (porCat[a] || 0) || (estado.orcamentos[b] || 0) - (estado.orcamentos[a] || 0));
  if (!total) {
    $('#cat-conteudo').innerHTML = `${orc}<p class="vazio">Nenhum gasto neste período ainda.</p>`;
    return;
  }

  let acc = 0;
  const fatias = cats.filter((c) => porCat[c] > 0).map((c) => {
    const ini = acc;
    acc += (porCat[c] / total) * 100;
    return `${corCategoria(c)} ${ini}% ${acc}%`;
  });

  $('#cat-conteudo').innerHTML = `
    <div class="rosca" style="background:conic-gradient(${fatias.join(',')})">
      <div><small>Total</small><b>${brl(total)}</b></div></div>
    ${orc}
    <ul class="lista-cat">${cats.map((c) => {
      const g = porCat[c] || 0;
      const lim = (estado.orcamentos[c] || 0) * n;
      const aberta = estado.catAberta === c;
      const detalhe = lim
        ? `${barraOrc((g / lim) * 100)}<small class="muted">${g <= lim ? `faltam <b>${brl(lim - g)}</b> para o limite de ${brl(lim)}` : `<span class="neg">passou ${brl(g - lim)}</span> do limite de ${brl(lim)}`}</small>`
        : `<small class="muted">${((g / total) * 100).toFixed(0)}% dos gastos${n > 1 ? ` · ≈ ${brl(g / n)}/mês` : ''}</small>`;
      return `<li class="cat-item ${aberta ? 'aberta' : ''}">
        <button class="cat-linha" data-cat="${esc(c)}" aria-expanded="${aberta}">
          <span class="avatar pequeno" style="--c:${corCategoria(c)}">${emoji(c)}</span>
          <span class="cat-info"><span class="linha"><span>${esc(c)}</span><b>${brl(g)}</b></span>${detalhe}</span>
          <svg class="seta-cat" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        ${aberta ? lancsDaCategoria(c, gastos) : ''}
      </li>`;
    }).join('')}</ul>`;
}

function lancsDaCategoria(cat, gastos) {
  const itens = gastos.filter((l) => l.categoria === cat).sort(ordemRecente);
  if (!itens.length) return '<p class="vazio pequeno">Nenhum gasto nesta categoria no período.</p>';
  const MAX = 40;
  return `<ul class="cat-lancs">${itens.slice(0, MAX).map((l) => {
    const tags = [
      l.fixoId ? '🔁 fixo' : '',
      l.data > hoje() ? 'a vencer' : '',
      ['whatsapp', 'telegram'].includes(l.origem) ? '💬' : '',
    ].filter(Boolean).join(' · ');
    return `<li><button data-id="${l.id}" class="${l.data > hoje() ? 'futuro' : ''}">
      <span class="cl-data">${dataCurta(l.data)}</span>
      <span class="cl-desc"><span>${esc(l.descricao || l.categoria)}</span>${tags ? `<small>${tags}</small>` : ''}</span>
      <b>${brl(l.valor)}</b></button></li>`;
  }).join('')}</ul>
  ${itens.length > MAX ? `<p class="muted centro pequeno">+ ${itens.length - MAX} mais antigos</p>` : ''}`;
}

function renderEvolucao() {
  let meses;
  if (estado.periodo === 'mes') meses = Array.from({ length: 12 }, (_, i) => somaMes(estado.mes, i - 11));
  else if (estado.periodo === 'ano') meses = Array.from({ length: 12 }, (_, i) => `${estado.ano}-${pad(i + 1)}`);
  else meses = mesesDoPeriodo();
  const porMes = somar(gastosDe(estado.lancs.filter(contaNoTotal)), 'mes');
  const valores = meses.map((m) => porMes[m] || 0);
  const comDados = valores.filter((v) => v > 0);
  if (!comDados.length) {
    $('#evolucao').innerHTML = '<p class="vazio">Ainda não há meses para comparar.</p>';
    return;
  }
  const max = Math.max(...valores);
  const media = comDados.reduce((a, b) => a + b, 0) / comDados.length;
  $('#evo-sub').textContent = `média ${brl(media)}`;
  $('#evolucao').innerHTML = `<div class="evo ${meses.length > 12 ? 'rolavel' : ''}">
    <i class="evo-media" style="bottom:calc(20px + (100% - 38px) * ${media / max})"></i>
    ${meses.map((m, i) => `<button class="evo-col ${estado.periodo === 'mes' && m === estado.mes ? 'sel' : ''} ${m > mesAtual() ? 'futuro' : ''}"
      data-mes="${m}" title="${cap(nomeMes(m))}: ${brl(valores[i])}">
      <span class="evo-area"><small style="bottom:calc(${(valores[i] / max) * 100}% + 2px)">${valores[i] ? compacto(valores[i]) : ''}</small>
        <span class="evo-barra" style="height:${(valores[i] / max) * 100}%"></span></span>
      <span class="evo-rot">${mesCurto(m)}${m.endsWith('-01') || i === 0 ? `<br>${m.slice(2, 4)}` : ''}</span>
    </button>`).join('')}
  </div>`;
  if (meses.length > 12) $('.evo').scrollLeft = 99999;
}

// Os 5 mais recentes do período; fixos que ainda vão vencer ficam de fora.
function renderUltimos(gastos) {
  const ultimos = gastos.filter((l) => l.data <= hoje()).sort(ordemRecente).slice(0, 5);
  $('#ultimos').innerHTML = ultimos.map((l) => itemHtml(l)).join('')
    || '<li class="vazio">Toque em <b>+</b> para lançar o primeiro gasto.</li>';
}

function renderPessoas(gastos, total) {
  if (!COM_PESSOAS) return;
  const porPessoa = Object.entries(somar(gastos, 'quem')).sort((a, b) => b[1] - a[1]);
  $('#pessoas-conteudo').innerHTML = porPessoa.length ? `
    <div class="barra-empilhada">${porPessoa.map(([p, v]) => `<span style="flex:${v};background:${corPessoa(p)}"></span>`).join('')}</div>
    <ul class="legenda">${porPessoa.map(([p, v]) => `<li><i style="background:${corPessoa(p)}"></i><span>${esc(p)}</span>
      <b>${brl(v)}</b><small class="muted">${((v / total) * 100).toFixed(0)}%</small></li>`).join('')}</ul>`
    : '<p class="vazio">Nada por aqui ainda.</p>';
}

function ordemRecente(a, b) {
  return b.data.localeCompare(a.data) || (b.criadoEm?.seconds || 0) - (a.criadoEm?.seconds || 0);
}

$('#seg-periodo').onclick = (e) => {
  const b = e.target.closest('[data-periodo]');
  if (!b || b.dataset.periodo === estado.periodo) return;
  estado.periodo = b.dataset.periodo;
  estado.ano = Number(estado.mes.slice(0, 4));
  estado.catAberta = null;
  renderTudo();
};
$('#cat-conteudo').onclick = (e) => {
  const lanc = e.target.closest('[data-id]');
  if (lanc) return abrirSheet('lanc', estado.lancs.find((l) => l.id === lanc.dataset.id));
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  estado.catAberta = estado.catAberta === b.dataset.cat ? null : b.dataset.cat;
  renderResumo();
};
$('#evolucao').onclick = (e) => {
  const b = e.target.closest('[data-mes]');
  if (!b) return;
  estado.periodo = 'mes';
  if (b.dataset.mes === estado.mes) renderTudo();
  else irParaMes(b.dataset.mes);
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const filtrados = lancsDoMes(estado.mes)
    .filter((l) => contaNoTotal(l) && (!f.tipo || l.tipo === f.tipo) && (!f.categoria || l.categoria === f.categoria) && (!f.quem || l.quem === f.quem))
    .filter((l) => !busca || normal(`${l.descricao} ${l.categoria} ${l.quem}`).includes(busca))
    .sort(ordemRecente);
  const lista = filtrados;
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
  }).join('') + (lista.length ? '' : `<div class="vazio grande"><span>${filtrando ? '🔍' : '🧾'}</span>
    ${filtrando ? 'Nenhum lançamento com esses filtros.' : 'Nenhum lançamento neste mês.<br>Toque em <b>+</b> para adicionar.'}</div>`);
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

  const lista = COM_RECEITAS ? grupo('receita', 'Receitas') + grupo('gasto', 'Gastos') : grupo('gasto', '');
  $('#lista-fixos').innerHTML = lista
    || '<div class="vazio grande"><span>🔁</span>Nenhum fixo ainda.<br>Toque em <b>+</b> para cadastrar assinaturas e débitos automáticos de valor fixo.</div>';
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
  toast('Limites salvos');
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
  if (modo === 'fixo') {
    // Some também o que ele ainda ia lançar este mês; os já vencidos ficam no histórico.
    const removidos = limparFuturos(id, false);
    gravar(removidos.then(() => deleteDoc(doc(db, 'fixos', id))));
    toast('Fixo excluído', {
      rotulo: 'Desfazer',
      fn: () => gravar(removidos.then((lista) => {
        const b = writeBatch(db);
        b.set(doc(db, 'fixos', id), dados);
        lista.forEach(({ id: lid, ...l }) => b.set(doc(db, 'lancamentos', lid), l));
        return b.commit();
      })),
    });
    return;
  }
  gravar(deleteDoc(doc(db, colecao, id)));
  toast('Lançamento excluído', {
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
      irPara('fixos');
    } else if (item) {
      // Um lançamento de fixo editado à mão fica marcado para não ser refeito quando o fixo mudar.
      const extra = item.fixoId ? { confirmado: true } : {};
      gravar(updateDoc(doc(db, 'lancamentos', item.id), { ...base, data, mes, ...extra }));
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
      // Refaz os lançamentos que ainda não venceram com os dados novos (ou só apaga, se pausou).
      gravar(updateDoc(doc(db, 'fixos', item.id), dados).then(() => limparFuturos(item.id)));
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
