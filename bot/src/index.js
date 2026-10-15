// Bot do Telegram que lança os gastos no Firestore. Roda no Cloudflare Workers.
// Configuração (segredos do Worker):
//   FIREBASE_SERVICE_ACCOUNT       chave JSON da conta de serviço do Firebase
//   TELEGRAM_TOKEN                 token do bot, dado pelo @BotFather
//   TELEGRAM_USUARIOS_PERMITIDOS   IDs do Telegram que podem lançar gastos, separados por vírgula
// O Telegram é avisado do endereço do bot pela publicação (.github/workflows/publicar.yml), com um segredo
// derivado do token (segredoWebhook) que volta em cada chamada e prova que ela veio do Telegram.
import { conectar } from './firestore.js';
import { interpretar, escolherCategoria, mesmaConta, normal } from './interpretar.js';

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

// Segredo que o Telegram manda no cabeçalho de cada chamada. Sai do próprio token para não exigir
// mais um segredo; a publicação calcula o mesmo valor ao registrar o webhook.
export async function segredoWebhook(token) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`webhook:${token}`)));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

function criarBot(env, db) {
  async function responder(chat, texto) {
    const enviar = (extra) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texto, ...extra }),
    });
    let r = await enviar({ parse_mode: 'Markdown' });
    // Uma descrição com * ou _ quebra a formatação; nesse caso vai sem negrito.
    if (r.status === 400) r = await enviar({});
    if (!r.ok) console.error('Falha ao responder no Telegram', r.status, await r.text());
  }

  async function totalDoMes(mes) {
    const docs = await db.consultar('lancamentos', [['mes', 'EQUAL', mes]]);
    return docs.reduce((s, d) => s + (d.dados.tipo === 'gasto' ? d.dados.valor : 0), 0);
  }

  // "luz 187,40": se a descrição bate com um fixo mensal de valor variável, grava o valor real da conta do mês
  // (no mesmo lançamento que o app gera para esse fixo) e usa esse valor como estimativa dos próximos meses.
  async function confirmarConta(chat, r, mes) {
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
    await responder(chat, `✅ Conta *${fixo.dados.descricao}* de ${nomeMes(mes)}: ${brl(r.valor)}`
      + `${estimado !== r.valor ? ` (estimativa era ${brl(estimado)})` : ''}\n`
      + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nPara corrigir, mande de novo com o valor certo.`);
    return true;
  }

  async function lancar(chat, autor, msg) {
    const r = interpretar(msg.text);
    if (!r) return responder(chat, `Não encontrei o valor 🤔\n\n${AJUDA}`);

    const data = dataSP(r.diasAtras);
    const mes = data.slice(0, 7);
    if (await confirmarConta(chat, r, mes)) return;

    const config = (await db.ler('config/geral'))?.dados || {};
    const categoria = escolherCategoria(r.descricao, config.catGasto?.length ? config.catGasto : CAT_PADRAO);
    try {
      // O id da mensagem no documento evita duplicar quando o Telegram reenvia a mesma atualização.
      await db.gravar([{
        criar: `lancamentos/tg_${msg.chat.id}_${msg.message_id}`.replace(/-/g, 'n'),
        dados: {
          tipo: 'gasto', valor: r.valor, categoria, descricao: r.descricao, quem: '', data, mes,
          origem: 'telegram', criadoPor: autor,
        },
        agoraEm: 'criadoEm',
      }]);
    } catch (e) {
      if (e.jaExiste) return; // reenvio da mesma mensagem
      throw e;
    }
    const extra = r.descricao && normal(r.descricao) !== normal(categoria) ? ` · ${r.descricao}` : '';
    const quando = ['', ' (ontem)', ' (anteontem)'][r.diasAtras];
    return responder(chat, `✅ ${brl(r.valor)} em *${categoria}*${extra}${quando}\n`
      + `Total de ${nomeMes(mes)}: ${brl(await totalDoMes(mes))}\n\nErrou? Mande *desfazer*.`);
  }

  async function desfazer(chat, autor) {
    const mes = dataSP().slice(0, 7);
    const docs = await db.consultar('lancamentos', [['criadoPor', 'EQUAL', autor], ['mes', 'IN', [mes, mesAnterior(mes)]]]);
    const ultimo = docs.sort((a, b) => (b.dados.criadoEm?.getTime() || 0) - (a.dados.criadoEm?.getTime() || 0))[0];
    if (!ultimo) return responder(chat, 'Não achei nenhum gasto seu recente para desfazer.');
    await db.gravar([{ apagar: ultimo.caminho }]);
    return responder(chat, `🗑️ Apaguei ${brl(ultimo.dados.valor)} em ${ultimo.dados.categoria}`
      + `${ultimo.dados.descricao ? ` (${ultimo.dados.descricao})` : ''}.`);
  }

  async function resumo(chat) {
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
    return responder(chat, `📊 Gastos de ${nomeMes(mes)}: *${brl(total)}*${top ? `\n\n${top}` : ''}`);
  }

  return async function tratar(msg) {
    const chat = msg.chat.id;
    const usuario = String(msg.from?.id || '');
    const permitidos = (env.TELEGRAM_USUARIOS_PERMITIDOS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!permitidos.includes(usuario)) {
      console.warn('Mensagem de usuário não autorizado', usuario);
      // Só em conversa direta: responder em grupo exporia o bot a quem nem falou com ele.
      if (msg.chat.type === 'private') {
        return responder(chat, `Este bot é privado. Seu ID do Telegram é ${usuario}: passe esse número para quem cuida do bot.`);
      }
      return;
    }
    const autor = `telegram:${usuario}`;
    if (typeof msg.text !== 'string') return responder(chat, `Por enquanto só entendo mensagens de texto.\n\n${AJUDA}`);
    // "/total@nome_do_bot" e "/total" valem o mesmo que "total".
    const cmd = normal(msg.text).replace(/^\//, '').replace(/@\S+$/, '').replace(/[!?.]/g, '');
    if (['desfazer', 'apagar', 'cancelar', 'excluir'].includes(cmd)) return desfazer(chat, autor);
    if (['total', 'resumo', 'quanto', 'gastos'].includes(cmd)) return resumo(chat);
    if (['start', 'ajuda', 'oi', 'ola', 'menu', 'help', 'bom dia', 'boa tarde', 'boa noite'].includes(cmd)) return responder(chat, AJUDA);
    return lancar(chat, autor, msg);
  };
}

export default {
  async fetch(req, env) {
    if (req.method === 'GET') return new Response('Bot de gastos no ar.');
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    if (!env.TELEGRAM_TOKEN || req.headers.get('x-telegram-bot-api-secret-token') !== await segredoWebhook(env.TELEGRAM_TOKEN)) {
      console.warn('Chamada sem o segredo do Telegram');
      return new Response(null, { status: 401 });
    }
    const update = await req.json();
    const msg = update.message;
    if (!msg?.chat) return new Response(null, { status: 200 });
    console.log('Mensagem recebida', msg.chat.type, msg.from?.id);
    try {
      await criarBot(env, conectar(env.FIREBASE_SERVICE_ACCOUNT))(msg);
    } catch (e) {
      console.error('Erro ao tratar mensagem', e);
    }
    return new Response(null, { status: 200 });
  },
};
