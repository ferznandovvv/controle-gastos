import { firebaseConfig, EMAILS_PERMITIDOS } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, query, where, addDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp, arrayUnion, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const PADRAO = {
  pessoas: ['Fernando', 'Esposa', 'Conta conjunta'],
  catGasto: ['Mercado', 'Moradia', 'Contas da casa', 'Transporte', 'Saúde', 'Restaurante', 'Lazer',
    'Compras', 'Educação', 'Assinaturas', 'Pets', 'Outros'],
  catReceita: ['Salário', 'Freela', 'Rendimentos', 'Outros'],
};
const CORES = ['#0f766e', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#059669',
  '#0891b2', '#ca8a04', '#4f46e5', '#ea580c', '#64748b'];

const estado = {
  user: null,
  mes: mesAtual(),
  aba: 'resumo',
  lancs: [],
  fixos: [],
  config: { ...PADRAO },
  orcamentos: {},
  unsubs: [],
  unsubLancs: null,
};

// ---------- utilitários ----------
const $ = (s) => document.querySelector(s);
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function hoje() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function somaMes(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function nomeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const s = new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
}
function parseValor(s) {
  s = String(s).trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}
function somar(lista, campo) {
  const r = {};
  for (const l of lista) r[l[campo] || 'Sem categoria'] = (r[l[campo] || 'Sem categoria'] || 0) + l.valor;
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
function linhas(texto) {
  return [...new Set(texto.split('\n').map((s) => s.trim()).filter(Boolean))];
}

// ---------- Firebase ----------
const configurado = !String(firebaseConfig.apiKey).startsWith('COLE');
let auth, db;
let mensagemLogin = '';

if (!configurado) {
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
    if (!permitidos.includes((user.email || '').toLowerCase())) {
      mensagemLogin = `A conta ${user.email} não tem acesso.`;
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
  $('#app').classList.add('hidden');
  $('#tela-login').classList.remove('hidden');
  $('#login-msg').textContent = mensagemLogin;
  mensagemLogin = '';
}
function mostrarApp() {
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

// Cria, para o mês em exibição, os lançamentos dos fixos que ainda não foram gerados.
async function gerarFixos() {
  const mes = estado.mes;
  if (mes > mesAtual()) return;
  const [a, m] = mes.split('-').map(Number);
  const ultimoDia = new Date(a, m, 0).getDate();
  for (const f of estado.fixos) {
    if (f.ativo === false || mes < f.inicio || (f.gerados || []).includes(mes)) continue;
    const b = writeBatch(db);
    b.set(doc(db, 'lancamentos', `${f.id}_${mes}`), {
      tipo: f.tipo, valor: f.valor, categoria: f.categoria, descricao: f.descricao || '', quem: f.quem,
      data: `${mes}-${pad(Math.min(f.dia, ultimoDia))}`, mes, fixoId: f.id,
      criadoPor: 'automático', criadoEm: serverTimestamp(),
    });
    b.update(doc(db, 'fixos', f.id), { gerados: arrayUnion(mes) });
    await b.commit();
  }
}

// ---------- navegação ----------
function trocarMes(n) {
  estado.mes = somaMes(estado.mes, n);
  estado.lancs = [];
  renderTudo();
  assinarLancamentos();
  gerarFixos().catch(console.error);
}
$('#mes-ant').onclick = () => trocarMes(-1);
$('#mes-prox').onclick = () => trocarMes(1);

const TITULOS = { fixos: 'Gastos e receitas fixos', ajustes: 'Ajustes' };
document.querySelectorAll('.tabbar button').forEach((b) => {
  b.onclick = () => {
    estado.aba = b.dataset.aba;
    document.querySelectorAll('.tabbar button').forEach((x) => x.classList.toggle('ativo', x === b));
    document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('hidden', s.id !== `aba-${estado.aba}`));
    const comMes = estado.aba === 'resumo' || estado.aba === 'lancamentos';
    $('.nav-mes').classList.toggle('hidden', !comMes);
    $('#titulo-aba').classList.toggle('hidden', comMes);
    $('#titulo-aba').textContent = TITULOS[estado.aba] || '';
    $('#fab').classList.toggle('hidden', estado.aba === 'ajustes');
    if (estado.aba === 'ajustes') renderAjustes();
    window.scrollTo(0, 0);
  };
});
$('#fab').onclick = () => abrirDialogo(estado.aba === 'fixos' ? 'fixo' : 'lanc');

// ---------- renderização ----------
function renderTudo() {
  $('#mes-titulo').textContent = nomeMes(estado.mes);
  renderResumo();
  renderLancamentos();
  renderFixos();
}

let grafico;
function renderResumo() {
  if (!estado.user) return;
  const atual = estado.lancs.filter((l) => l.mes === estado.mes);
  const anterior = estado.lancs.filter((l) => l.mes === somaMes(estado.mes, -1));
  const t = totais(atual);
  const ta = totais(anterior);
  const saldo = t.receitas - t.gastos;

  $('#card-receitas').textContent = brl(t.receitas);
  $('#card-gastos').textContent = brl(t.gastos);
  $('#card-saldo').textContent = brl(saldo);
  $('#card-saldo').className = saldo < 0 ? 'neg' : 'pos';
  if (ta.gastos > 0) {
    const v = ((t.gastos - ta.gastos) / ta.gastos) * 100;
    $('#comp-gastos').textContent = `${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(0)}% vs mês anterior`;
  } else {
    $('#comp-gastos').textContent = 'sem gastos no mês anterior';
  }

  // Por categoria + orçamento
  const gastos = atual.filter((l) => l.tipo === 'gasto');
  const porCat = somar(gastos, 'categoria');
  const cats = [...new Set([...Object.keys(porCat), ...Object.keys(estado.orcamentos).filter((c) => estado.orcamentos[c] > 0)])]
    .sort((a, b) => (porCat[b] || 0) - (porCat[a] || 0));
  const comGasto = cats.filter((c) => porCat[c] > 0);

  $('#grafico-wrap').classList.toggle('hidden', !comGasto.length);
  $('#sem-gastos').classList.toggle('hidden', comGasto.length > 0);
  $('#grafico-total').textContent = brl(t.gastos);
  if (comGasto.length && window.Chart) {
    const dados = { labels: comGasto, valores: comGasto.map((c) => porCat[c]), cores: comGasto.map(corCategoria) };
    if (grafico) {
      grafico.data.labels = dados.labels;
      grafico.data.datasets[0].data = dados.valores;
      grafico.data.datasets[0].backgroundColor = dados.cores;
      grafico.update();
    } else {
      grafico = new Chart($('#grafico-cat'), {
        type: 'doughnut',
        data: { labels: dados.labels, datasets: [{ data: dados.valores, backgroundColor: dados.cores, borderWidth: 0 }] },
        options: {
          cutout: '68%',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => ` ${c.label}: ${brl(c.parsed)}` } },
          },
        },
      });
    }
  }

  $('#lista-cat').innerHTML = cats.map((c) => {
    const gasto = porCat[c] || 0;
    const limite = estado.orcamentos[c] || 0;
    const pct = limite ? (gasto / limite) * 100 : 0;
    const classe = pct > 100 ? 'estourou' : pct > 80 ? 'alerta' : '';
    return `<li>
      <div class="linha"><span><i class="ponto" style="background:${corCategoria(c)}"></i>${esc(c)}</span>
        <strong>${brl(gasto)}</strong></div>
      ${limite ? `<div class="barra ${classe}"><div style="width:${Math.min(pct, 100)}%"></div></div>
        <small class="muted">${pct.toFixed(0)}% de ${brl(limite)} · ${gasto <= limite ? `restam ${brl(limite - gasto)}` : `passou ${brl(gasto - limite)}`}</small>` : ''}
    </li>`;
  }).join('');

  // Por pessoa
  const porPessoa = somar(gastos, 'quem');
  const maior = Math.max(0, ...Object.values(porPessoa));
  $('#lista-pessoas').innerHTML = Object.entries(porPessoa).sort((a, b) => b[1] - a[1]).map(([p, v]) => `<li>
      <div class="linha"><span>${esc(p)}</span><strong>${brl(v)}</strong></div>
      <div class="barra neutra"><div style="width:${(v / maior) * 100}%"></div></div>
    </li>`).join('') || '<p class="vazio">Nada por aqui ainda.</p>';
}

function opcoes(lista, selecionado, vazio) {
  return (vazio ? `<option value="">${vazio}</option>` : '')
    + lista.map((x) => `<option ${x === selecionado ? 'selected' : ''}>${esc(x)}</option>`).join('');
}

function renderLancamentos() {
  if (!estado.user) return;
  const fc = $('#filtro-cat'), fp = $('#filtro-pessoa'), ft = $('#filtro-tipo');
  const doMes = estado.lancs.filter((l) => l.mes === estado.mes);
  const todasCats = [...new Set([...estado.config.catGasto, ...estado.config.catReceita, ...doMes.map((l) => l.categoria)])];
  const todasPessoas = [...new Set([...estado.config.pessoas, ...doMes.map((l) => l.quem)])];
  fc.innerHTML = opcoes(todasCats, fc.value, 'Todas categorias');
  fp.innerHTML = opcoes(todasPessoas, fp.value, 'Todas pessoas');

  const lista = doMes
    .filter((l) => (!ft.value || l.tipo === ft.value) && (!fc.value || l.categoria === fc.value) && (!fp.value || l.quem === fp.value))
    .sort((a, b) => b.data.localeCompare(a.data) || (b.criadoEm?.seconds || 0) - (a.criadoEm?.seconds || 0));

  const t = totais(lista);
  $('#total-filtro').textContent = lista.length
    ? `${lista.length} lançamento(s) · gastos ${brl(t.gastos)}${t.receitas ? ` · receitas ${brl(t.receitas)}` : ''}`
    : '';

  const grupos = {};
  for (const l of lista) (grupos[l.data] ||= []).push(l);
  $('#lista-lanc').innerHTML = Object.entries(grupos).map(([data, itens]) => `
    <h3 class="data">${new Date(`${data}T12:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}</h3>
    <ul class="itens">${itens.map((l) => `
      <li data-id="${l.id}">
        <i class="ponto" style="background:${l.tipo === 'receita' ? '#059669' : corCategoria(l.categoria)}"></i>
        <div class="info"><span>${esc(l.descricao || l.categoria)}</span>
          <small class="muted">${esc(l.categoria)} · ${esc(l.quem)}${l.fixoId ? ' · 🔁' : ''}</small></div>
        <strong class="${l.tipo === 'receita' ? 'pos' : ''}">${l.tipo === 'receita' ? '+' : ''}${brl(l.valor)}</strong>
      </li>`).join('')}</ul>`).join('')
    || '<p class="vazio">Nenhum lançamento neste mês. Toque em + para adicionar.</p>';
}
['#filtro-cat', '#filtro-pessoa', '#filtro-tipo'].forEach((s) => { $(s).onchange = renderLancamentos; });
$('#lista-lanc').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) abrirDialogo('lanc', estado.lancs.find((l) => l.id === li.dataset.id));
};

function renderFixos() {
  if (!estado.user) return;
  const ativos = estado.fixos.filter((f) => f.ativo !== false);
  const t = totais(ativos);
  $('#fixo-receitas').textContent = brl(t.receitas);
  $('#fixo-gastos').textContent = brl(t.gastos);
  const lista = [...estado.fixos].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.dia - b.dia);
  $('#lista-fixos').innerHTML = lista.length ? `<ul class="itens">${lista.map((f) => `
    <li data-id="${f.id}" class="${f.ativo === false ? 'inativo' : ''}">
      <i class="ponto" style="background:${f.tipo === 'receita' ? '#059669' : corCategoria(f.categoria)}"></i>
      <div class="info"><span>${esc(f.descricao || f.categoria)}</span>
        <small class="muted">Dia ${f.dia} · ${esc(f.categoria)} · ${esc(f.quem)}${f.ativo === false ? ' · pausado' : ''}</small></div>
      <strong class="${f.tipo === 'receita' ? 'pos' : ''}">${f.tipo === 'receita' ? '+' : ''}${brl(f.valor)}</strong>
    </li>`).join('')}</ul>`
    : '<p class="vazio">Nenhum fixo cadastrado. Toque em + para adicionar salário, aluguel, luz, assinaturas…</p>';
}
$('#lista-fixos').onclick = (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) abrirDialogo('fixo', estado.fixos.find((f) => f.id === li.dataset.id));
};

function renderAjustes() {
  if (!estado.user || $('#aba-ajustes').contains(document.activeElement)) return;
  $('#cfg-pessoas').value = estado.config.pessoas.join('\n');
  $('#cfg-cat-gasto').value = estado.config.catGasto.join('\n');
  $('#cfg-cat-receita').value = estado.config.catReceita.join('\n');
  $('#orc-campos').innerHTML = estado.config.catGasto.map((c) => `
    <label class="orc"><span><i class="ponto" style="background:${corCategoria(c)}"></i>${esc(c)}</span>
      <input data-cat="${esc(c)}" inputmode="decimal" placeholder="sem limite"
        value="${estado.orcamentos[c] ? String(estado.orcamentos[c].toFixed(2)).replace('.', ',') : ''}"></label>`).join('');
}

$('#salvar-config').onclick = async () => {
  const novo = {
    pessoas: linhas($('#cfg-pessoas').value),
    catGasto: linhas($('#cfg-cat-gasto').value),
    catReceita: linhas($('#cfg-cat-receita').value),
  };
  if (!novo.pessoas.length || !novo.catGasto.length || !novo.catReceita.length) {
    alert('Cada lista precisa ter pelo menos um item.');
    return;
  }
  document.activeElement?.blur();
  await salvar(() => setDoc(doc(db, 'config', 'geral'), novo), 'Salvo!');
};
$('#salvar-orc').onclick = async () => {
  const limites = {};
  for (const inp of document.querySelectorAll('#orc-campos input')) {
    const v = parseValor(inp.value);
    if (inp.value.trim() && v > 0) limites[inp.dataset.cat] = v;
  }
  document.activeElement?.blur();
  await salvar(() => setDoc(doc(db, 'config', 'orcamentos'), { limites }), 'Orçamentos salvos!');
};

async function salvar(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    alert(`Não foi possível salvar: ${e.message}`);
  }
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2000);
}

// ---------- diálogo ----------
const dlg = $('#dlg-item');
const form = $('#form-item');
let editando = null;

function pessoaPadrao() {
  const ultima = (() => { try { return localStorage.getItem('ultimaPessoa'); } catch { return null; } })();
  if (ultima && estado.config.pessoas.includes(ultima)) return ultima;
  const primeiroNome = (estado.user?.displayName || '').split(' ')[0];
  return estado.config.pessoas.find((p) => p.toLowerCase() === primeiroNome.toLowerCase()) || estado.config.pessoas[0];
}
function preencherCategorias(tipo, sel) {
  const lista = tipo === 'receita' ? estado.config.catReceita : estado.config.catGasto;
  form.categoria.innerHTML = opcoes(sel && !lista.includes(sel) ? [...lista, sel] : lista, sel);
}
form.querySelectorAll('input[name=tipo]').forEach((r) => { r.onchange = () => preencherCategorias(r.value); });

function abrirDialogo(modo, item) {
  editando = { modo, id: item?.id || null };
  form.reset();
  $('#dlg-titulo').textContent = `${item ? 'Editar' : 'Novo'} ${modo === 'fixo' ? 'fixo mensal' : 'lançamento'}`;
  form.tipo.value = item?.tipo || 'gasto';
  form.valor.value = item ? item.valor.toFixed(2).replace('.', ',') : '';
  $('#campo-data').hidden = modo !== 'lanc';
  $('#campo-dia').hidden = modo !== 'fixo';
  $('#campo-ativo').hidden = modo !== 'fixo';
  form.data.value = item?.data || (estado.mes === mesAtual() ? hoje() : `${estado.mes}-01`);
  form.dia.value = item?.dia || new Date().getDate();
  preencherCategorias(form.tipo.value, item?.categoria);
  form.descricao.value = item?.descricao || '';
  const quem = item?.quem || pessoaPadrao();
  form.quem.innerHTML = opcoes(estado.config.pessoas.includes(quem) ? estado.config.pessoas : [...estado.config.pessoas, quem], quem);
  form.ativo.checked = item ? item.ativo !== false : true;
  $('#btn-excluir').hidden = !item;
  $('#aviso-fixo').hidden = !(modo === 'lanc' && item?.fixoId);
  dlg.showModal();
  if (!item) setTimeout(() => form.valor.focus(), 50);
}

$('#btn-cancelar').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('#btn-excluir').onclick = async () => {
  const { modo, id } = editando;
  const msg = modo === 'fixo'
    ? 'Excluir este fixo? Os lançamentos já gerados nos meses anteriores continuam.'
    : 'Excluir este lançamento?';
  if (!confirm(msg)) return;
  dlg.close();
  await salvar(() => deleteDoc(doc(db, modo === 'fixo' ? 'fixos' : 'lancamentos', id)));
};

form.onsubmit = async (e) => {
  e.preventDefault();
  const valor = parseValor(form.valor.value);
  if (!(valor > 0)) {
    alert('Informe um valor válido.');
    return;
  }
  const base = {
    tipo: form.tipo.value,
    valor,
    categoria: form.categoria.value,
    descricao: form.descricao.value.trim(),
    quem: form.quem.value,
  };
  try { localStorage.setItem('ultimaPessoa', base.quem); } catch { /* sem armazenamento */ }
  const { modo, id } = editando;
  dlg.close();

  if (modo === 'lanc') {
    base.data = form.data.value;
    base.mes = base.data.slice(0, 7);
    if (base.mes !== estado.mes) {
      estado.mes = base.mes;
      renderTudo();
      assinarLancamentos();
    }
    await salvar(() => (id
      ? updateDoc(doc(db, 'lancamentos', id), base)
      : addDoc(collection(db, 'lancamentos'), { ...base, criadoPor: estado.user.email, criadoEm: serverTimestamp() })));
  } else {
    base.dia = Math.min(31, Math.max(1, parseInt(form.dia.value, 10) || 1));
    base.ativo = form.ativo.checked;
    await salvar(() => (id
      ? updateDoc(doc(db, 'fixos', id), base)
      : addDoc(collection(db, 'fixos'), { ...base, inicio: mesAtual(), gerados: [], criadoPor: estado.user.email, criadoEm: serverTimestamp() })));
  }
};

// ---------- PWA ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
