import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretar, escolherCategoria } from './interpretar.js';

const CATS = ['Mercado', 'Bebê', 'Moradia', 'Contas da casa', 'Transporte', 'Saúde', 'Restaurante', 'Lazer',
  'Viagem', 'Compras', 'Roupas', 'Beleza', 'Presentes', 'Educação', 'Assinaturas', 'Pets', 'Outros'];

test('valores e descrições', () => {
  const casos = [
    ['45,90 mercado', 45.9, 'Mercado', 0],
    ['mercado 45,90', 45.9, 'Mercado', 0],
    ['uber 23', 23, 'Uber', 0],
    ['R$ 1.234,56 aluguel', 1234.56, 'Aluguel', 0],
    ['1.200 aluguel', 1200, 'Aluguel', 0],
    ['12.5 café', 12.5, 'Café', 0],
    ['ontem 120 farmácia', 120, 'Farmácia', 1],
    ['gastei 30 reais no ifood', 30, 'Ifood', 0],
    ['80 - pizza', 80, 'Pizza', 0],
    ['50', 50, '', 0],
  ];
  for (const [texto, valor, descricao, diasAtras] of casos) {
    assert.deepEqual(interpretar(texto), { valor, descricao, diasAtras }, texto);
  }
});

test('sem valor', () => {
  assert.equal(interpretar('oi'), null);
  assert.equal(interpretar('total'), null);
  assert.equal(interpretar('0 mercado'), null);
});

test('categorias', () => {
  assert.equal(escolherCategoria('Mercado', CATS), 'Mercado');
  assert.equal(escolherCategoria('Uber', CATS), 'Transporte');
  assert.equal(escolherCategoria('Farmácia', CATS), 'Saúde');
  assert.equal(escolherCategoria('Ifood', CATS), 'Restaurante');
  assert.equal(escolherCategoria('Conta de luz', CATS), 'Contas da casa');
  assert.equal(escolherCategoria('Netflix', CATS), 'Assinaturas');
  assert.equal(escolherCategoria('Ração', CATS), 'Pets');
  assert.equal(escolherCategoria('Fralda', CATS), 'Bebê');
  assert.equal(escolherCategoria('Pediatra', CATS), 'Bebê');
  assert.equal(escolherCategoria('Bebê', CATS), 'Bebê');
  assert.equal(escolherCategoria('Roupa Renner', CATS), 'Roupas');
  assert.equal(escolherCategoria('Salão', CATS), 'Beleza');
  assert.equal(escolherCategoria('Hotel praia', CATS), 'Viagem');
  assert.equal(escolherCategoria('Pao de queijo', CATS), 'Outros');
  assert.equal(escolherCategoria('', CATS), 'Outros');
});
