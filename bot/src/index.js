// Recebe mensagens do WhatsApp (API oficial da Meta) e lança os gastos no Firestore.
// Roda no Cloudflare Workers. Configuração (todas como segredos do Worker):
//   FIREBASE_SERVICE_ACCOUNT     chave JSON da conta de serviço do Firebase
//   WHATSAPP_TOKEN               token de acesso da Meta
//   WHATSAPP_APP_SECRET          chave secreta do app da Meta (confere a assinatura do webhook)
//   WHATSAPP_VERIFY_TOKEN        texto qualquer, informado também na Meta ao cadastrar o webhook
//   WHATSAPP_PHONE_NUMBER_ID     ID do número de telefone do bot
//   WHATSAPP_NUMEROS_PERMITIDOS  números que podem lançar gastos, separados por vírgula (ex.: 5511999998888)
import { conectar } from './firestore.js';
import { interpretar, escolherCategoria, mesmaConta, normal } from './interpretar.js';

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

// Celular do Brasil que chega sem o 9 (55 + DDD + 8 dígitos começando em 6-9) volta a ter o 9 na resposta;
// sem isso a Meta não reconhece o destinatário e a mensagem não é entregue.
export function comNove(numero) {
  const n = String(numero).replace(/\D/g, '');
  return /^55\d{2}[6-9]\d{7}$/.test(n) ? `${n.slice(0, 4)}9${n.slice(4)}` : n;
}

async function assinaturaValida(env, corpo, recebida) {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.WHATSAPP_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', chave, corpo));
  const esperada = `sha256=${[...hmac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (!recebida || recebida.length !== esperada.length) return false;
  let dif = 0;
  for (let i = 0; i < esperada.length; i++) dif |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i);
  return dif === 0;
}

function criarBot(env, db) {
  async function responder(para, texto) {
    const r = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: comNove(para), type: 'text', text: { body: texto } }),
    });
    if (!r.ok) console.error('Falha ao responder no WhatsApp', r.status, await r.text());
  }

  async function totalDoMes(mes) {
    const docs = await db.consultar('lancamentos', [['mes', 'EQUAL', mes]]);
    return docs.reduce((s, d) => s + (d.dados.tipo === 'gasto' ? d.dados.valor : 0), 0);
  }

  // "luz 187,40": se a descrição bate com um fixo mensal de valor variável, grava o valor real da conta do mês
  // (no mesmo lançamento que o app gera para esse fixo) e usa esse valor como estimativa dos próximos meses.
  async function confirmarConta(de, r, mes) {
    if (!normal(r.descricao)) return false;
    const fixos = await db.consultar('fixos', [['variavel', 'EQUAL', true]]);
    const fixo = fixos.find((d) => d.dados.ativo !== false && d.dados.frequencia !== 'semanal'
      && mesmaConta(d.dados.descricao, r.descricao));
    if (!fixo) return false;

    const caminho = `lancamentos/${fixo.id}_${mes}`;
    const atual = await db.ler(caminho);
    const estimado = atual ? atual.dados.valor : fixo.dados.valor;
    const dados = {
      tipo: 'gasto', valor: r.valor, categoria: fixo.dados.categoria, descricao: fixo.dados.descricao || '', quem: '',
      mes, fixoId: fixo.id, confirmado: true,
    };
    let lancamento;
    if (atual) {
      lancamento = { alterar: caminho, dados };
    } else {
      const [a, m] = mes.split('-').map(Number);
      const dia = String(Math.min(fixo.dados.dia, new Date(Date.UTC(a, m, 0)).getUTCDate())).padStart(2, '0');
      lancamento = { gravar: caminho, dados: { ...dados, data: `${mes}-${dia}`, criadoPor: 'automático' }, agoraEm: 'criadoEm' };
    }
    await db.gravar([lancamento, { alterar: fixo.caminho, dados: { valor: r.valor }, unirEmLista: { gerados: [mes] } }]);
    await responder(de, `✅ Conta *${fixo.dados.descricao}* de ${nomeMes(mes)}: ${brl(r.valor)}`
      + `${estimado !== r.valor ? ` (estimativa era ${brl(estimado)})` : ''}\n`
      + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nPara corrigir, mande de novo com o valor certo.`);
    return true;
  }

  async function lancar(de, msg) {
    const r = interpretar(msg.text.body);
    if (!r) return responder(de, `Não encontrei o valor 🤔\n\n${AJUDA}`);

    const data = dataSP(r.diasAtras);
    const mes = data.slice(0, 7);
    if (await confirmarConta(de, r, mes)) return;

    const config = (await db.ler('config/geral'))?.dados || {};
    const categoria = escolherCategoria(r.descricao, config.catGasto?.length ? config.catGasto : CAT_PADRAO);
    try {
      // O id da mensagem como id do documento evita duplicar quando a Meta reenvia o webhook.
      await db.gravar([{
        criar: `lancamentos/${`wa_${msg.id}`.replace(/[^\w.-]/g, '_')}`,
        dados: {
          tipo: 'gasto', valor: r.valor, categoria, descricao: r.descricao, quem: '', data, mes,
          origem: 'whatsapp', criadoPor: `whatsapp:${finalNumero(de)}`,
        },
        agoraEm: 'criadoEm',
      }]);
    } catch (e) {
      if (e.jaExiste) return; // reenvio da mesma mensagem
      throw e;
    }
    const extra = r.descricao && normal(r.descricao) !== normal(categoria) ? ` · ${r.descricao}` : '';
    const quando = ['', ' (ontem)', ' (anteontem)'][r.diasAtras];
    return responder(de, `✅ ${brl(r.valor)} em *${categoria}*${extra}${quando}\n`
      + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nErrou? Mande *desfazer*.`);
  }

  async function desfazer(de) {
    const mes = dataSP().slice(0, 7);
    const docs = await db.consultar('lancamentos', [
      ['criadoPor', 'EQUAL', `whatsapp:${finalNumero(de)}`],
      ['mes', 'IN', [mes, mesAnterior(mes)]],
    ]);
    const ultimo = docs.sort((a, b) => (b.dados.criadoEm?.getTime() || 0) - (a.dados.criadoEm?.getTime() || 0))[0];
    if (!ultimo) return responder(de, 'Não achei nenhum gasto seu recente para desfazer.');
    await db.gravar([{ apagar: ultimo.caminho }]);
    return responder(de, `🗑️ Apaguei ${brl(ultimo.dados.valor)} em ${ultimo.dados.categoria}`
      + `${ultimo.dados.descricao ? ` (${ultimo.dados.descricao})` : ''}.`);
  }

  async function resumo(de) {
    const mes = dataSP().slice(0, 7);
    const docs = await db.consultar('lancamentos', [['mes', 'EQUAL', mes]]);
    const porCat = {};
    let total = 0;
    for (const { dados: d } of docs) {
      if (d.tipo !== 'gasto') continue;
      total += d.valor;
      porCat[d.categoria] = (porCat[d.categoria] || 0) + d.valor;
    }
    const top = Object.entries(porCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([c, v]) => `• ${c}: ${brl(v)}`).join('\n');
    return responder(de, `📊 Gastos de ${nomeMes(mes)}: *${brl(total)}*${top ? `\n\n${top}` : ''}`);
  }

  return async function tratar(msg) {
    const de = msg.from;
    const permitidos = (env.WHATSAPP_NUMEROS_PERMITIDOS || '').split(',').map(finalNumero).filter(Boolean);
    if (!permitidos.includes(finalNumero(de))) {
      console.warn('Mensagem de número não autorizado', finalNumero(de));
      return;
    }
    if (msg.type !== 'text') return responder(de, `Por enquanto só entendo mensagens de texto.\n\n${AJUDA}`);
    const cmd = normal(msg.text.body).replace(/[!?.]/g, '');
    if (['desfazer', 'apagar', 'cancelar', 'excluir'].includes(cmd)) return desfazer(de);
    if (['total', 'resumo', 'quanto', 'gastos'].includes(cmd)) return resumo(de);
    if (['ajuda', 'oi', 'ola', 'menu', 'help', 'bom dia', 'boa tarde', 'boa noite'].includes(cmd)) return responder(de, AJUDA);
    return lancar(de, msg);
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Verificação do webhook, feita uma vez pela Meta ao configurar.
    if (req.method === 'GET') {
      const p = url.searchParams;
      if (!p.has('hub.mode')) return new Response('Bot de gastos no ar.');
      const ok = env.WHATSAPP_VERIFY_TOKEN && p.get('hub.mode') === 'subscribe' && p.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN;
      return ok ? new Response(p.get('hub.challenge')) : new Response(null, { status: 403 });
    }
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    const corpo = await req.arrayBuffer();
    if (!(await assinaturaValida(env, corpo, req.headers.get('x-hub-signature-256')))) {
      console.warn('Webhook com assinatura inválida');
      return new Response(null, { status: 401 });
    }
    const tratar = criarBot(env, conectar(env.FIREBASE_SERVICE_ACCOUNT));
    const json = JSON.parse(new TextDecoder().decode(corpo));
    const valores = (json.entry || []).flatMap((e) => e.changes || []).map((c) => c.value || {});
    // A Meta avisa depois se uma resposta não pôde ser entregue; sem registrar isso a falha passa em silêncio.
    for (const s of valores.flatMap((v) => v.statuses || []).filter((s) => s.status === 'failed')) {
      console.error('WhatsApp não entregou a resposta', finalNumero(s.recipient_id), JSON.stringify(s.errors));
    }
    const mensagens = valores.flatMap((v) => v.messages || []);
    for (const msg of mensagens) {
      console.log('Mensagem recebida', msg.type, finalNumero(msg.from));
      try {
        await tratar(msg);
      } catch (e) {
        console.error('Erro ao tratar mensagem', e);
      }
    }
    return new Response(null, { status: 200 });
  },
};
