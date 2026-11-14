/**
 * D1 data access for the poker bot. Uses only the D1 API surface
 * (prepare/bind/first/all/run/batch).
 */

/**
 * @typedef {import('../core/types.js').GameSnapshot} GameSnapshot
 */

/**
 * Record a Telegram update id; true if it was not seen before.
 * @param {any} db D1Database
 * @param {number} updateId
 * @returns {Promise<boolean>}
 */
export async function markUpdate(db, updateId) {
  const res = await db
    .prepare('INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)')
    .bind(updateId)
    .run();
  return res.meta.changes > 0;
}

/**
 * Id of the open (active/counting) game in a chat.
 * @param {any} db D1Database
 * @param {number} chatId
 * @returns {Promise<number | null>}
 */
export async function findOpenGame(db, chatId) {
  const row = await db
    .prepare(
      "SELECT id FROM games WHERE chat_id = ? AND status IN ('active', 'counting')",
    )
    .bind(chatId)
    .first();
  return row ? row.id : null;
}

/**
 * Create a game; throws if the chat already has an open one.
 * @param {any} db D1Database
 * @param {{chatId: number, chipsPerBuyin: number, priceKop: number, createdBy: number}} p
 * @returns {Promise<number>}
 */
export async function createGame(db, { chatId, chipsPerBuyin, priceKop, createdBy }) {
  const res = await db
    .prepare(
      "INSERT INTO games (chat_id, chips_per_buyin, price_kop, created_by, status)"
      + " VALUES (?, ?, ?, ?, 'active')",
    )
    .bind(chatId, chipsPerBuyin, priceKop, createdBy)
    .run();
  return res.meta.last_row_id;
}

/**
 * Store a Telegram message id on a game.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {'message_id' | 'count_message_id'} field
 * @param {number} messageId
 * @returns {Promise<void>}
 */
export async function setMessageId(db, gameId, field, messageId) {
  if (field !== 'message_id' && field !== 'count_message_id') {
    throw new Error(`bad field: ${field}`);
  }
  await db
    .prepare(`UPDATE games SET ${field} = ? WHERE id = ?`)
    .bind(messageId, gameId)
    .run();
}

/**
 * Load a full game snapshot.
 * @param {any} db D1Database
 * @param {number} gameId
 * @returns {Promise<GameSnapshot | null>}
 */
export async function loadGame(db, gameId) {
  const g = await db.prepare('SELECT * FROM games WHERE id = ?').bind(gameId).first();
  if (!g) return null;
  const [players, entries, stacks] = await db.batch([
    db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY id ASC').bind(gameId),
    db.prepare('SELECT * FROM entries WHERE game_id = ? ORDER BY id ASC').bind(gameId),
    db.prepare('SELECT * FROM stacks WHERE game_id = ? ORDER BY player_id ASC').bind(gameId),
  ]);
  return {
    id: g.id,
    chatId: g.chat_id,
    messageId: g.message_id,
    countMessageId: g.count_message_id,
    chipsPerBuyin: g.chips_per_buyin,
    priceKop: g.price_kop,
    status: g.status,
    createdBy: g.created_by,
    players: players.results.map((p) => ({
      id: p.id,
      tgUserId: p.tg_user_id,
      name: p.name,
      addedBy: p.added_by,
    })),
    entries: entries.results.map((e) => ({
      id: e.id,
      playerId: e.player_id,
      kind: e.kind,
      createdBy: e.created_by,
      cancelled: e.cancelled_at !== null,
    })),
    stacks: stacks.results.map((s) => ({
      playerId: s.player_id,
      chips: s.chips,
      enteredBy: s.entered_by,
    })),
  };
}

/**
 * Find the game whose count message is the given one.
 * @param {any} db D1Database
 * @param {number} chatId
 * @param {number} messageId
 * @returns {Promise<number | null>}
 */
export async function findGameByCountMessage(db, chatId, messageId) {
  const row = await db
    .prepare('SELECT id FROM games WHERE chat_id = ? AND count_message_id = ?')
    .bind(chatId, messageId)
    .first();
  return row ? row.id : null;
}

/**
 * Latest counting game in which the user is a player.
 * @param {any} db D1Database
 * @param {number} tgUserId
 * @returns {Promise<number | null>}
 */
export async function findCountingGameForDm(db, tgUserId) {
  const row = await db
    .prepare(
      "SELECT g.id FROM games g JOIN players p ON p.game_id = g.id"
      + " WHERE g.status = 'counting' AND p.tg_user_id = ?"
      + " ORDER BY g.id DESC LIMIT 1",
    )
    .bind(tgUserId)
    .first();
  return row ? row.id : null;
}

/**
 * Add a player with a buyin entry; repeat tgUserId is a no-op.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {{tgUserId: number | null, name: string, addedBy: number}} p
 * @returns {Promise<{playerId: number, created: boolean}>}
 */
export async function addPlayer(db, gameId, { tgUserId, name, addedBy }) {
  if (tgUserId !== null) {
    const existing = await db
      .prepare('SELECT id FROM players WHERE game_id = ? AND tg_user_id = ?')
      .bind(gameId, tgUserId)
      .first();
    if (existing) return { playerId: existing.id, created: false };
  }
  try {
    const [ins] = await db.batch([
      db
        .prepare(
          "INSERT INTO players (game_id, tg_user_id, name, added_by) VALUES (?, ?, ?, ?)",
        )
        .bind(gameId, tgUserId, name, addedBy),
      db
        .prepare(
          "INSERT INTO entries (game_id, player_id, kind, created_by)"
          + " VALUES (?, last_insert_rowid(), 'buyin', ?)",
        )
        .bind(gameId, addedBy),
    ]);
    return { playerId: ins.meta.last_row_id, created: true };
  } catch (e) {
    // Concurrent join: another request inserted the same tg_user_id first.
    if (tgUserId !== null && /UNIQUE constraint failed/i.test(String(e && e.message))) {
      const existing = await db
        .prepare('SELECT id FROM players WHERE game_id = ? AND tg_user_id = ?')
        .bind(gameId, tgUserId)
        .first();
      if (existing) return { playerId: existing.id, created: false };
    }
    throw e;
  }
}

/**
 * Add a buyin/rebuy entry.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {number} playerId
 * @param {'buyin' | 'rebuy'} kind
 * @param {number} createdBy
 * @returns {Promise<void>}
 */
export async function addEntry(db, gameId, playerId, kind, createdBy) {
  await db
    .prepare(
      "INSERT INTO entries (game_id, player_id, kind, created_by) VALUES (?, ?, ?, ?)",
    )
    .bind(gameId, playerId, kind, createdBy)
    .run();
}

/**
 * Mark an entry cancelled.
 * @param {any} db D1Database
 * @param {number} entryId
 * @returns {Promise<void>}
 */
export async function cancelEntry(db, entryId) {
  await db
    .prepare(
      "UPDATE entries SET cancelled_at = unixepoch()"
      + " WHERE id = ? AND cancelled_at IS NULL",
    )
    .bind(entryId)
    .run();
}

/**
 * Insert or replace a player's final stack.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {number} playerId
 * @param {number} chips
 * @param {number} enteredBy
 * @returns {Promise<void>}
 */
export async function upsertStack(db, gameId, playerId, chips, enteredBy) {
  await db
    .prepare(
      "INSERT INTO stacks (game_id, player_id, chips, entered_by) VALUES (?, ?, ?, ?)"
      + " ON CONFLICT (game_id, player_id) DO UPDATE SET"
      + " chips = excluded.chips, entered_by = excluded.entered_by,"
      + " updated_at = unixepoch()",
    )
    .bind(gameId, playerId, chips, enteredBy)
    .run();
}

/**
 * Conditionally change status; true if a row changed.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {string[]} fromStatuses
 * @param {string} to
 * @returns {Promise<boolean>}
 */
export async function setStatus(db, gameId, fromStatuses, to) {
  const marks = fromStatuses.map(() => '?').join(', ');
  const res = await db
    .prepare(`UPDATE games SET status = ? WHERE id = ? AND status IN (${marks})`)
    .bind(to, gameId, ...fromStatuses)
    .run();
  return res.meta.changes > 0;
}

/**
 * Change buyin size and price.
 * @param {any} db D1Database
 * @param {number} gameId
 * @param {number} chipsPerBuyin
 * @param {number} priceKop
 * @returns {Promise<void>}
 */
export async function setPrice(db, gameId, chipsPerBuyin, priceKop) {
  await db
    .prepare('UPDATE games SET chips_per_buyin = ?, price_kop = ? WHERE id = ?')
    .bind(chipsPerBuyin, priceKop, gameId)
    .run();
}
