import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretar, escolherCategoria, observacao, mesmaConta } from './interpretar.js';

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

test('mesma conta com nomes diferentes', () => {
  assert.ok(mesmaConta('Energia', 'Luz'));
  assert.ok(mesmaConta('Luz', 'Energia'));
  assert.ok(mesmaConta('Conta de luz', 'Enel'));
  assert.ok(mesmaConta('Água', 'Sabesp'));
  assert.ok(mesmaConta('Internet', 'Vivo fibra'));
  assert.ok(mesmaConta('Babá', 'Babá'));
  assert.ok(!mesmaConta('Energia', 'Água'));
  assert.ok(!mesmaConta('Internet', 'Luz'));
  assert.ok(!mesmaConta('Aluguel', 'IPTU'));
  assert.ok(!mesmaConta('Luz', ''));
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

test('observação sem a palavra que só indicava a categoria', () => {
  const casos = [
    ['45,90 mercado arroz e carne', 'Mercado', 'Arroz e carne'],
    ['120 farmácia remédio do bebê', 'Bebê', 'Farmácia remédio do bebê'],
    ['120 farmácia dipirona', 'Saúde', 'Farmácia dipirona'],
    ['ontem 80 restaurante aniversário da mãe', 'Restaurante', 'Aniversário da mãe'],
    ['45,90 mercado', 'Mercado', 'Mercado'],
    ['uber 23', 'Transporte', 'Uber'],
    ['50 presentes aniversário do João', 'Presentes', 'Aniversário do João'],
    ['30 bebê fraldas', 'Bebê', 'Fraldas'],
    ['30 pizza com a família', 'Restaurante', 'Pizza com a família'],
    ['200 contas da casa conserto do chuveiro', 'Contas da casa', 'Conserto do chuveiro'],
  ];
  for (const [texto, categoria, esperado] of casos) {
    const r = interpretar(texto);
    assert.equal(escolherCategoria(r.descricao, CATS), categoria, texto);
    assert.equal(observacao(r.descricao, categoria), esperado, texto);
  }
});
