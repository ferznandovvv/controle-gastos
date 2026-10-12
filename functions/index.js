// Recebe mensagens do WhatsApp (API oficial da Meta) e lança os gastos no Firestore.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { onRequest } from 'firebase-functions/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { setGlobalOptions, logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { interpretar, escolherCategoria, normal } from './interpretar.js';

setGlobalOptions({ region: 'southamerica-east1', maxInstances: 2 });
initializeApp();
const db = getFirestore();

const WA_TOKEN = defineSecret('WHATSAPP_TOKEN');
const WA_APP_SECRET = defineSecret('WHATSAPP_APP_SECRET');
const WA_VERIFY_TOKEN = defineString('WHATSAPP_VERIFY_TOKEN');
const WA_PHONE_ID = defineString('WHATSAPP_PHONE_NUMBER_ID');
const WA_PERMITIDOS = defineString('WHATSAPP_NUMEROS_PERMITIDOS', {
  description: 'Números que podem lançar gastos, separados por vírgula (ex.: 5511999998888)',
});
const GRAPH = 'https://graph.facebook.com/v23.0';

// Mesma lista padrão do app (public/app.js), usada enquanto ninguém editar as categorias.
const CAT_PADRAO = ['Mercado', 'Bebê', 'Moradia', 'Contas da casa', 'Transporte', 'Saúde', 'Restaurante', 'Lazer',
  'Viagem', 'Compras', 'Roupas', 'Beleza', 'Presentes', 'Educação', 'Assinaturas', 'Pets', 'Outros'];
const AJUDA = 'Mande o valor e o que foi, por exemplo:\n'
  + '• *45,90 mercado*\n• *uber 23*\n• *ontem 120 farmácia*\n\n'
  + 'Comandos: *total* (gastos do mês) e *desfazer* (apaga o último).';

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fusoSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const dataSP = (diasAtras = 0) => fusoSP.format(new Date(Date.now() - diasAtras * 86400000));
function nomeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, 15)).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' });
}
function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 2, 15)).toISOString().slice(0, 7);
}

// Compara pelos 8 últimos dígitos: o WhatsApp às vezes manda números do Brasil sem o 9.
const finalNumero = (n) => String(n).replace(/\D/g, '').slice(-8);
function permitido(numero) {
  return WA_PERMITIDOS.value().split(',').map(finalNumero).filter(Boolean).includes(finalNumero(numero));
}

function assinaturaValida(req) {
  const recebida = Buffer.from(req.get('x-hub-signature-256') || '');
  const esperada = Buffer.from(`sha256=${createHmac('sha256', WA_APP_SECRET.value()).update(req.rawBody).digest('hex')}`);
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

async function responder(para, texto) {
  const r = await fetch(`${GRAPH}/${WA_PHONE_ID.value()}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
  });
  if (!r.ok) logger.error('Falha ao responder no WhatsApp', r.status, await r.text());
}

async function totalDoMes(mes) {
  const snap = await db.collection('lancamentos').where('mes', '==', mes).get();
  return snap.docs.reduce((s, d) => s + (d.get('tipo') === 'gasto' ? d.get('valor') : 0), 0);
}

async function lancar(de, msg) {
  const r = interpretar(msg.text.body);
  if (!r) return responder(de, `Não encontrei o valor 🤔\n\n${AJUDA}`);

  const config = (await db.doc('config/geral').get()).data() || {};
  const categoria = escolherCategoria(r.descricao, config.catGasto?.length ? config.catGasto : CAT_PADRAO);
  const data = dataSP(r.diasAtras);
  const mes = data.slice(0, 7);
  try {
    // O id da mensagem como id do documento evita duplicar quando a Meta reenvia o webhook.
    await db.collection('lancamentos').doc(`wa_${msg.id}`.replace(/[^\w.-]/g, '_')).create({
      tipo: 'gasto', valor: r.valor, categoria, descricao: r.descricao, quem: '', data, mes,
      origem: 'whatsapp', criadoPor: `whatsapp:${finalNumero(de)}`, criadoEm: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e.code === 6) return; // já existe: reenvio da mesma mensagem
    throw e;
  }
  const extra = r.descricao && normal(r.descricao) !== normal(categoria) ? ` · ${r.descricao}` : '';
  const quando = ['', ' (ontem)', ' (anteontem)'][r.diasAtras];
  return responder(de, `✅ ${brl(r.valor)} em *${categoria}*${extra}${quando}\n`
    + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nErrou? Mande *desfazer*.`);
}

async function desfazer(de) {
  const mes = dataSP().slice(0, 7);
  const snap = await db.collection('lancamentos')
    .where('criadoPor', '==', `whatsapp:${finalNumero(de)}`)
    .where('mes', 'in', [mes, mesAnterior(mes)])
    .get();
  const ultimo = snap.docs.sort((a, b) => (b.get('criadoEm')?.toMillis() || 0) - (a.get('criadoEm')?.toMillis() || 0))[0];
  if (!ultimo) return responder(de, 'Não achei nenhum gasto seu recente para desfazer.');
  await ultimo.ref.delete();
  return responder(de, `🗑️ Apaguei ${brl(ultimo.get('valor'))} em ${ultimo.get('categoria')}`
    + `${ultimo.get('descricao') ? ` (${ultimo.get('descricao')})` : ''}.`);
}

async function resumo(de) {
  const mes = dataSP().slice(0, 7);
  const snap = await db.collection('lancamentos').where('mes', '==', mes).get();
  const porCat = {};
  let total = 0;
  for (const d of snap.docs) {
    if (d.get('tipo') !== 'gasto') continue;
    total += d.get('valor');
    porCat[d.get('categoria')] = (porCat[d.get('categoria')] || 0) + d.get('valor');
  }
  const top = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([c, v]) => `• ${c}: ${brl(v)}`).join('\n');
  return responder(de, `📊 Gastos de ${nomeMes(mes)}: *${brl(total)}*${top ? `\n\n${top}` : ''}`);
}

async function tratar(msg) {
  const de = msg.from;
  if (!permitido(de)) {
    logger.warn('Mensagem de número não autorizado', { final: finalNumero(de) });
    return;
  }
  if (msg.type !== 'text') return responder(de, `Por enquanto só entendo mensagens de texto.\n\n${AJUDA}`);
  const cmd = normal(msg.text.body).replace(/[!?.]/g, '');
  if (['desfazer', 'apagar', 'cancelar', 'excluir'].includes(cmd)) return desfazer(de);
  if (['total', 'resumo', 'quanto', 'gastos'].includes(cmd)) return resumo(de);
  if (['ajuda', 'oi', 'ola', 'menu', 'help', 'bom dia', 'boa tarde', 'boa noite'].includes(cmd)) return responder(de, AJUDA);
  return lancar(de, msg);
}

export const whatsapp = onRequest({ secrets: [WA_TOKEN, WA_APP_SECRET] }, async (req, res) => {
  // Verificação do webhook, feita uma vez pela Meta ao configurar.
  if (req.method === 'GET') {
    const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN.value();
    return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
  }
  if (req.method !== 'POST') return res.sendStatus(405);
  if (!assinaturaValida(req)) {
    logger.warn('Webhook com assinatura inválida');
    return res.sendStatus(401);
  }
  const mensagens = (req.body.entry || []).flatMap((e) => e.changes || []).flatMap((c) => c.value?.messages || []);
  for (const msg of mensagens) {
    try {
      await tratar(msg);
    } catch (e) {
      logger.error('Erro ao tratar mensagem', e);
    }
  }
  return res.sendStatus(200);
});
