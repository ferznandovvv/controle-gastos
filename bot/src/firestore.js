// Cliente mínimo da API REST do Firestore, autenticado com a chave de uma conta de serviço.
// A biblioteca firebase-admin não roda no Cloudflare Workers, por isso o acesso é direto.

const ESCOPO = 'https://www.googleapis.com/auth/datastore';
// Sem limite, uma chamada presa ao Google deixaria o Atalho girando até o iPhone desistir.
const LIMITE_MS = 10000;
let cacheToken = { chave: '', token: '', expira: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlTexto = (s) => b64url(new TextEncoder().encode(s));

async function tokenDeAcesso(conta) {
  if (cacheToken.chave === conta.private_key_id && Date.now() < cacheToken.expira) return cacheToken.token;
  const der = Uint8Array.from(atob(conta.private_key.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const agora = Math.floor(Date.now() / 1000);
  const corpo = `${b64urlTexto(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: conta.private_key_id }))}.`
    + b64urlTexto(JSON.stringify({ iss: conta.client_email, scope: ESCOPO, aud: conta.token_uri, iat: agora, exp: agora + 3600 }));
  const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(corpo));
  const r = await fetch(conta.token_uri, {
    signal: AbortSignal.timeout(LIMITE_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${corpo}.${b64url(assinatura)}` }),
  });
  if (!r.ok) throw new Error(`Falha ao obter token do Google: ${r.status} ${await r.text()}`);
  const { access_token: token, expires_in: validade } = await r.json();
  cacheToken = { chave: conta.private_key_id, token, expira: Date.now() + (validade - 300) * 1000 };
  return token;
}

// Conversão entre valores JS e o formato tipado da API ({ stringValue: ... } etc.).
export function paraValor(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(paraValor) } };
  return { mapValue: { fields: paraCampos(v) } };
}
export const paraCampos = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, paraValor(v)]));

export function deValor(v) {
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deValor);
  if ('mapValue' in v) return deCampos(v.mapValue.fields);
  if ('nullValue' in v) return null;
  return Object.values(v)[0];
}
export const deCampos = (campos = {}) => Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, deValor(v)]));

export class ErroFirestore extends Error {
  constructor(status, corpo) {
    super(`Firestore ${status}: ${corpo}`);
    this.status = status;
    this.jaExiste = status === 409 || /ALREADY_EXISTS/.test(corpo);
  }
}

export function conectar(chaveJson) {
  const conta = JSON.parse(chaveJson);
  const raiz = `projects/${conta.project_id}/databases/(default)/documents`;
  const url = `https://firestore.googleapis.com/v1/${raiz}`;

  async function chamar(caminho, corpo) {
    const r = await fetch(`${url}${caminho}`, {
      signal: AbortSignal.timeout(LIMITE_MS),
      method: corpo ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${await tokenDeAcesso(conta)}`, 'Content-Type': 'application/json' },
      body: corpo && JSON.stringify(corpo),
    });
    if (r.status === 404 && !corpo) return null;
    if (!r.ok) throw new ErroFirestore(r.status, await r.text());
    return r.json();
  }

  const doc = (d) => ({ id: d.name.split('/').pop(), caminho: d.name.slice(raiz.length + 1), dados: deCampos(d.fields) });

  return {
    // Retorna { id, caminho, dados } ou null se o documento não existir.
    async ler(caminho) {
      const d = await chamar(`/${caminho}`);
      return d && doc(d);
    },

    // filtros: [['campo', 'EQUAL' | 'IN', valor], ...]; sem filtros, a coleção inteira.
    async consultar(colecao, filtros = []) {
      const f = filtros.map(([campo, op, valor]) => ({ fieldFilter: { field: { fieldPath: campo }, op, value: paraValor(valor) } }));
      const where = f.length > 1 ? { compositeFilter: { op: 'AND', filters: f } } : f[0];
      const res = await chamar(':runQuery', { structuredQuery: { from: [{ collectionId: colecao }], ...(where && { where }) } });
      return res.filter((r) => r.document).map((r) => doc(r.document));
    },

    // Grava várias alterações de uma vez (tudo ou nada). Cada item:
    //   { criar: caminho, dados, agoraEm? }           falha com jaExiste se o documento já existir
    //   { gravar: caminho, dados, agoraEm? }          cria ou substitui
    //   { alterar: caminho, dados, unirEmLista? }     muda só os campos informados
    //   { apagar: caminho }
    // agoraEm: campo que recebe a hora do servidor. unirEmLista: { campo: [valores] } (sem repetir).
    async gravar(alteracoes) {
      const writes = alteracoes.map((a) => {
        if (a.apagar) return { delete: `${raiz}/${a.apagar}` };
        const caminho = a.criar || a.gravar || a.alterar;
        const w = { update: { name: `${raiz}/${caminho}`, fields: paraCampos(a.dados) } };
        if (a.criar) w.currentDocument = { exists: false };
        if (a.alterar) {
          w.updateMask = { fieldPaths: Object.keys(a.dados) };
          w.currentDocument = { exists: true };
        }
        const transformacoes = [];
        if (a.agoraEm) transformacoes.push({ fieldPath: a.agoraEm, setToServerValue: 'REQUEST_TIME' });
        for (const [campo, valores] of Object.entries(a.unirEmLista || {})) {
          transformacoes.push({ fieldPath: campo, appendMissingElements: { values: valores.map(paraValor) } });
        }
        if (transformacoes.length) w.updateTransforms = transformacoes;
        return w;
      });
      await chamar(':commit', { writes });
    },
  };
}
