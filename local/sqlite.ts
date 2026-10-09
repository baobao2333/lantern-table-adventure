import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Result<T = Record<string, unknown>> = {
  success: true;
  results: T[];
  meta: { changes: number };
};
export class SQLiteStatement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}
  bind(...values: SQLInputValue[]) {
    return new SQLiteStatement(this.database, this.sql, values);
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values);
    return (row ? (column ? row[column] : row) : null) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<Result<T>> {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }
  execute(): Result {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
  async run() {
    return this.execute();
  }
}
export class SQLiteD1 {
  readonly sqlite: DatabaseSync;
  constructor(filename: string, migrationsDirectory: string) {
    this.sqlite = new DatabaseSync(filename);
    try {
    this.sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS lantern_migrations (name TEXT PRIMARY KEY NOT NULL);",
    );
    for (const name of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      if (
        this.sqlite
          .prepare("SELECT name FROM lantern_migrations WHERE name = ?")
          .get(name)
      )
        continue;
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.sqlite.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
        this.sqlite
          .prepare("INSERT INTO lantern_migrations (name) VALUES (?)")
          .run(name);
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }
  prepare(sql: string) {
    return new SQLiteStatement(this.sqlite, sql);
  }
  async batch(statements: SQLiteStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.sqlite.close();
  }
}
