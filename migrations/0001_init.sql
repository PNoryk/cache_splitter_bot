-- Timestamps are unix seconds. No foreign keys (Telegram Serverless compatibility).
CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  count_message_id INTEGER,
  chips_per_buyin INTEGER NOT NULL,
  price_kop INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX games_one_open_per_chat
  ON games (chat_id) WHERE status IN ('active', 'counting');

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  tg_user_id INTEGER,
  name TEXT NOT NULL,
  added_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX players_game_user
  ON players (game_id, tg_user_id) WHERE tg_user_id IS NOT NULL;

CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  cancelled_at INTEGER
);

CREATE INDEX entries_game ON entries (game_id);

CREATE TABLE stacks (
  game_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  chips INTEGER NOT NULL,
  entered_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (game_id, player_id)
);

CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
