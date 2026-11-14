import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  cb,
  parseCb,
  gameView,
  personalView,
  rebuyChooserView,
  countView,
  discrepancyView,
  resultView,
  cancelConfirmView,
} from '../platform/views.js';
import { settlement } from '../core/game.js';

/**
 * Game: 1000 chips = 50,00; Паша and Вася (tg) plus guest Дима; 4 entries.
 * @param {object} [over]
 * @returns {import('../core/types.js').GameSnapshot}
 */
function makeGame(over = {}) {
  return {
    id: 12,
    chatId: -1,
    messageId: 5,
    countMessageId: null,
    chipsPerBuyin: 1000,
    priceKop: 5000,
    status: 'active',
    createdBy: 100,
    players: [
      { id: 1, tgUserId: 100, name: 'Паша', addedBy: 100 },
      { id: 2, tgUserId: 101, name: 'Вася', addedBy: 101 },
      { id: 3, tgUserId: null, name: 'Дима', addedBy: 100 },
    ],
    entries: [
      { id: 1, playerId: 1, kind: 'buyin', createdBy: 100, cancelled: false },
      { id: 2, playerId: 2, kind: 'buyin', createdBy: 101, cancelled: false },
      { id: 3, playerId: 3, kind: 'buyin', createdBy: 100, cancelled: false },
      { id: 4, playerId: 2, kind: 'rebuy', createdBy: 100, cancelled: false },
    ],
    stacks: [],
    ...over,
  };
}

/**
 * All callback_data strings of a view.
 * @param {{reply_markup?: any}} v
 * @returns {string[]}
 */
function datas(v) {
  const rows = v.reply_markup?.inline_keyboard ?? [];
  return rows.flat().map((b) => b.callback_data).filter((d) => d !== undefined);
}

test('gameView shows header, bank, guest mark and invite link', () => {
  const v = gameView(makeGame(), 'cash_bot');
  assert.match(v.text, /^🃏 Игра · 1000 фишек = 50,00/);
  assert.ok(v.text.includes('Банк: 4000 фишек · 200,00'));
  assert.ok(v.text.includes('👤 Дима'));
  assert.ok(!v.text.includes('👤 Паша'));
  assert.ok(v.text.includes('2 закупа'));
  assert.ok(v.text.includes('Паша → докуп Вася'));
  const urls = v.reply_markup.inline_keyboard.flat().map((b) => b.url);
  assert.ok(urls.includes('https://t.me/cash_bot?start=join_12'));
});

test('gameView lists only last 5 rebuys made for others', () => {
  const entries = [{ id: 1, playerId: 1, kind: 'buyin', createdBy: 100, cancelled: false }];
  for (let i = 0; i < 7; i++) {
    entries.push({ id: 10 + i, playerId: 2, kind: 'rebuy', createdBy: 100, cancelled: false });
  }
  entries.push({ id: 30, playerId: 1, kind: 'rebuy', createdBy: 100, cancelled: false });
  entries.push({ id: 31, playerId: 2, kind: 'rebuy', createdBy: 100, cancelled: true });
  const v = gameView(makeGame({ entries }), 'b');
  assert.equal(v.text.split('→ докуп').length - 1, 5);
});

test('gameView for settled and cancelled has a note and no keyboard', () => {
  const s = gameView(makeGame({ status: 'settled' }), 'b');
  assert.ok(s.text.includes('✅ Рассчитана'));
  assert.equal(s.reply_markup, undefined);
  const c = gameView(makeGame({ status: 'cancelled' }), 'b');
  assert.ok(c.text.includes('❌ Игра отменена'));
  assert.equal(c.reply_markup, undefined);
});

test('gameView for counting only offers back', () => {
  const v = gameView(makeGame({ status: 'counting' }), 'b');
  assert.deepEqual(datas(v), ['12:back']);
  assert.ok(v.text.includes('Банк: 4000 фишек'));
});

test('plural of buyins', () => {
  const mk = (n) =>
    gameView(
      makeGame({
        players: [{ id: 1, tgUserId: 100, name: 'А', addedBy: 100 }],
        entries: Array.from({ length: n }, (_, i) => ({
          id: i + 1,
          playerId: 1,
          kind: 'buyin',
          createdBy: 100,
          cancelled: false,
        })),
      }),
      'b',
    ).text;
  assert.ok(mk(1).includes('1 закуп ·'));
  assert.ok(mk(3).includes('3 закупа'));
  assert.ok(mk(5).includes('5 закупов'));
  assert.ok(mk(11).includes('11 закупов'));
  assert.ok(mk(22).includes('22 закупа'));
  assert.ok(mk(0).includes('0 закупов'));
});

test('personalView has rebuy and undo buttons', () => {
  const v = personalView(makeGame());
  assert.match(v.text, /^🃏 Игра/);
  assert.deepEqual(datas(v), ['12:rebuy', '12:undo']);
});

test('rebuyChooserView: Себе for tg player, name with mark for guests', () => {
  const g = makeGame();
  const v = rebuyChooserView(g, [g.players[0], g.players[2]]);
  const btns = v.reply_markup.inline_keyboard.flat();
  assert.deepEqual(
    btns.map((b) => [b.text, b.callback_data]),
    [
      ['Себе', '12:rb:1'],
      ['Дима 👤', '12:rb:3'],
    ],
  );
});

test('countView shows stacks, entered-by and missing', () => {
  const g = makeGame({
    status: 'counting',
    stacks: [
      { playerId: 1, chips: 1370, enteredBy: 100 },
      { playerId: 3, chips: 500, enteredBy: 100 },
    ],
  });
  const v = countView(g);
  assert.ok(v.text.includes('Паша  1370 ✓'));
  assert.ok(v.text.includes('Вася  —'));
  assert.ok(v.text.includes('Дима 500 (ввёл Паша)'));
  assert.deepEqual(datas(v), ['12:zero', '12:back']);
  const unknown = countView(
    makeGame({ stacks: [{ playerId: 3, chips: 5, enteredBy: 999 }] }),
  );
  assert.ok(unknown.text.includes('(ввёл кто-то)'));
});

test('discrepancyView shows signed difference', () => {
  const g = makeGame({
    stacks: [
      { playerId: 1, chips: 2000, enteredBy: 100 },
      { playerId: 2, chips: 1000, enteredBy: 101 },
      { playerId: 3, chips: 1100, enteredBy: 100 },
    ],
  });
  const v = discrepancyView(g);
  assert.ok(v.text.includes('⚠️ На столе 4100, в банке 4000 — расхождение +100 (5,00)'));
  assert.deepEqual(datas(v), ['12:fix', '12:split']);
  const neg = discrepancyView({ ...g, stacks: g.stacks.map((s) => ({ ...s, chips: 0 })) });
  assert.ok(neg.text.includes('расхождение -4000 (-200,00)'));
});

test('resultView lists transfers; round gives whole amounts and Точно', () => {
  const g = makeGame({
    status: 'counting',
    stacks: [
      { playerId: 1, chips: 2000, enteredBy: 100 },
      { playerId: 2, chips: 1000, enteredBy: 101 },
      { playerId: 3, chips: 1000, enteredBy: 100 },
    ],
  });
  const exact = resultView(g, settlement(g, { split: false, round: false }), {
    round: false,
    split: false,
  });
  assert.ok(exact.text.includes('✅ Итог'));
  assert.ok(exact.text.includes('Вася → Паша 50,00'));
  assert.deepEqual(datas(exact), ['12:round']);
  const rounded = resultView(g, settlement(g, { split: false, round: true }), {
    round: true,
    split: false,
  });
  assert.ok(rounded.text.includes('Вася → Паша 50'));
  assert.ok(!rounded.text.includes('50,00'));
  assert.deepEqual(datas(rounded), ['12:exact']);
});

test('resultView with no transfers', () => {
  const v = resultView(makeGame(), { balances: [0, 0, 0], transfers: [] }, {
    round: false,
    split: false,
  });
  assert.ok(v.text.includes('Все при своих'));
});

test('cancelConfirmView asks and offers yes/no', () => {
  const v = cancelConfirmView(makeGame());
  assert.ok(v.text.includes('Точно отменить игру?'));
  assert.deepEqual(datas(v), ['12:cancel_yes', '12:cancel_no']);
});

test('all callback_data fit 64 bytes and use known actions', () => {
  const big = 999999;
  const g = makeGame({
    id: big,
    status: 'active',
    players: [
      { id: big, tgUserId: 100, name: 'А', addedBy: 100 },
      { id: big - 1, tgUserId: null, name: 'Б', addedBy: 100 },
    ],
    entries: [{ id: 1, playerId: big, kind: 'buyin', createdBy: 100, cancelled: false }],
  });
  const stacked = {
    ...g,
    stacks: g.players.map((p) => ({ playerId: p.id, chips: 1, enteredBy: 100 })),
  };
  const views = [
    gameView(g, 'bot'),
    personalView(g),
    rebuyChooserView(g, g.players),
    countView(g),
    discrepancyView(stacked),
    resultView(stacked, { balances: [], transfers: [] }, { round: false, split: false }),
    resultView(stacked, { balances: [], transfers: [] }, { round: true, split: false }),
    cancelConfirmView(g),
  ];
  const known = new Set(Object.values(ACTIONS));
  for (const v of views) {
    for (const d of datas(v)) {
      assert.ok(Buffer.byteLength(d) <= 64, d);
      const p = parseCb(d);
      assert.ok(p && known.has(p.action), d);
      assert.equal(p.gameId, big);
    }
  }
});

test('cb and parseCb round-trip', () => {
  assert.equal(cb(5, 'join'), '5:join');
  assert.equal(cb(5, 'rb', 7), '5:rb:7');
  assert.deepEqual(parseCb('5:rb:7'), { gameId: 5, action: 'rb', arg: '7' });
  assert.deepEqual(parseCb('5:join'), { gameId: 5, action: 'join', arg: null });
  assert.equal(parseCb('x:join'), null);
  assert.equal(parseCb('5'), null);
  assert.equal(parseCb('5:nope'), null);
  assert.equal(parseCb(''), null);
});

test('gameView cancelled note names the canceller when known', () => {
  const g = makeGame({ status: 'cancelled' });
  assert.ok(gameView(g, 'b', { cancelledByName: 'Аня' }).text.endsWith('❌ Игра отменена (Аня)'));
  assert.ok(gameView(g, 'b').text.endsWith('❌ Игра отменена'));
});
