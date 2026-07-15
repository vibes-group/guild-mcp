import Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { SCHEMA } from './schema.js';

export type DB = Database.Database;

// Открытие БД. WAL — для конкурентного доступа http-воркеров.
export function openDb(config: Config): DB {
  const db = new Database(config.DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
