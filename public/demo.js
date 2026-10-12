// Firebase falso, em memória, só para testar a interface em localhost (abrir com ?demo).
const store = new Map();
const ouvintes = new Set();
let seq = 0;

const usuario = { email: 'demo@exemplo.com', displayName: 'Fernando Demo' };
export const initializeApp = () => ({});
export const getAuth = () => ({});
export class GoogleAuthProvider {}
export const onAuthStateChanged = (_a, cb) => { setTimeout(() => cb(usuario)); return () => {}; };
export const signInWithPopup = async () => {};
export const signInWithRedirect = async () => {};
export const signOut = async () => {};

export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (_db, nome) => ({ tipo: 'col', nome });
export const doc = (_db, nome, id) => ({ tipo: 'doc', nome, id, path: `${nome}/${id}` });
export const where = (campo, op, valor) => ({ campo, op, valor });
export const query = (col, ...filtros) => ({ tipo: 'col', nome: col.nome, filtros });
export const serverTimestamp = () => ({ seconds: Date.now() / 1000 });
export const arrayUnion = (...v) => ({ __union: v });
export const arrayRemove = (...v) => ({ __remove: v });

function snapCol(ref) {
  const docs = [];
  for (const [path, data] of store) {
    const [nome, id] = path.split('/');
    if (nome !== ref.nome) continue;
    const ok = (ref.filtros || []).every((f) => (f.op === 'in' ? f.valor.includes(data[f.campo]) : data[f.campo] === f.valor));
    if (ok) docs.push({ id, data: () => ({ ...data }) });
  }
  return { docs, metadata: { fromCache: false } };
}
function snapDoc(ref) {
  const d = store.get(ref.path);
  return { id: ref.id, exists: () => !!d, data: () => d && { ...d }, metadata: { fromCache: false } };
}
const snap = (ref) => (ref.tipo === 'doc' ? snapDoc(ref) : snapCol(ref));

export const getDocs = async (ref) => {
  const s = snapCol(ref);
  return { docs: s.docs.map((d) => ({ ...d, ref: { tipo: 'doc', path: `${ref.nome}/${d.id}` } })) };
};
export const onSnapshot = (ref, cb) => {
  const o = { ref, cb };
  ouvintes.add(o);
  setTimeout(() => ouvintes.has(o) && cb(snap(ref)));
  return () => ouvintes.delete(o);
};

let agendado = false;
function mudou() {
  if (agendado) return;
  agendado = true;
  setTimeout(() => {
    agendado = false;
    for (const o of ouvintes) o.cb(snap(o.ref));
  });
}
function gravar(path, data, merge) {
  const r = merge ? { ...(store.get(path) || {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v?.__union) r[k] = [...new Set([...(r[k] || []), ...v.__union])];
    else if (v?.__remove) r[k] = (r[k] || []).filter((x) => !v.__remove.includes(x));
    else r[k] = v;
  }
  store.set(path, r);
}
export const setDoc = async (ref, data) => { gravar(ref.path, data); mudou(); };
export const updateDoc = async (ref, data) => { gravar(ref.path, data, true); mudou(); };
export const deleteDoc = async (ref) => { store.delete(ref.path); mudou(); };
export const addDoc = async (col, data) => {
  const id = `d${++seq}`;
  gravar(`${col.nome}/${id}`, data);
  mudou();
  return { id };
};
export const writeBatch = () => {
  const ops = [];
  return {
    set: (r, d) => ops.push(() => gravar(r.path, d)),
    update: (r, d) => ops.push(() => gravar(r.path, d, true)),
    delete: (r) => ops.push(() => store.delete(r.path)),
    commit: async () => { ops.forEach((f) => f()); mudou(); },
  };
};

// ---- dados de exemplo ----
const pad = (n) => String(n).padStart(2, '0');
const hoje = new Date();
const mesDe = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const atual = mesDe(hoje);
const anterior = mesDe(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));

const exemplos = [
  ['gasto', 'Mercado', 'Carrefour', 'Fernando', 412.37],
  ['gasto', 'Restaurante', 'Pizza sexta', 'Esposa', 96.5],
  ['gasto', 'Transporte', 'Gasolina', 'Fernando', 230],
  ['gasto', 'Lazer', 'Cinema', 'Conta conjunta', 68],
  ['gasto', 'Saúde', 'Farmácia', 'Esposa', 54.9],
  ['gasto', 'Mercado', 'Hortifruti', 'Esposa', 87.2],
  ['gasto', 'Compras', 'Presente aniversário', 'Fernando', 150],
  ['gasto', 'Restaurante', 'Almoço domingo', 'Conta conjunta', 132.4],
  ['gasto', 'Pets', 'Ração', 'Esposa', 189.9],
  ['gasto', 'Assinaturas', 'Netflix', 'Fernando', 44.9],
];
let n = 0;
for (const mes of [anterior, atual]) {
  const ultimo = mes === atual ? hoje.getDate() : 28;
  exemplos.forEach(([tipo, categoria, descricao, quem, valor], i) => {
    const dia = Math.max(1, Math.round(((i + 1) / exemplos.length) * ultimo));
    store.set(`lancamentos/x${++n}`, {
      tipo, categoria, descricao, quem, valor: mes === atual ? valor : Math.round(valor * 0.9 * 100) / 100,
      data: `${mes}-${pad(dia)}`, mes, criadoPor: 'demo', criadoEm: { seconds: n },
    });
  });
}
store.set('fixos/aluguel', { tipo: 'gasto', valor: 2100, dia: 10, categoria: 'Moradia', descricao: 'Aluguel', quem: 'Conta conjunta', ativo: true, inicio: anterior, gerados: [] });
store.set('fixos/luz', { tipo: 'gasto', valor: 210, dia: 15, categoria: 'Contas da casa', descricao: 'Luz', quem: 'Esposa', variavel: true, ativo: true, inicio: anterior, gerados: [] });
store.set('fixos/feira', { tipo: 'gasto', valor: 85, frequencia: 'semanal', diaSemana: 5, categoria: 'Mercado', descricao: 'Feira', quem: '', ativo: true, inicio: anterior, inicioData: `${anterior}-01`, gerados: [] });
store.set('config/orcamentos', { limites: { Mercado: 900, Restaurante: 300, Lazer: 250, Compras: 300 } });
