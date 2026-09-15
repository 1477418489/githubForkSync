import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

class Statement {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  execute() {
    const before = this.db.native.prepare("SELECT total_changes() AS count").get().count;
    const results = this.db.native.prepare(this.sql).all(...this.values).map((row) => ({ ...row }));
    const after = this.db.native.prepare("SELECT total_changes() AS count").get().count;
    return { success: true, results, meta: { changes: after - before } };
  }
  async first(column) {
    const row = this.execute().results[0];
    return column ? row?.[column] ?? null : row ?? null;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}

// 测试使用真实 SQLite 执行与 D1 相同的 SQL；只适配 D1 的异步调用接口。
export class TestDatabase {
  constructor({ migrate = true, filename = ":memory:" } = {}) {
    this.native = new DatabaseSync(filename);
    this.sessionConstraints = [];
    if (migrate) this.applyMigrations();
  }
  applyMigrations() {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      this.native.exec(readFileSync(new URL(file, directory), "utf8"));
    }
  }
  withSession(constraint) { this.sessionConstraints.push(constraint); return this; }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.native.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.native.exec("COMMIT");
      return results;
    } catch (error) { this.native.exec("ROLLBACK"); throw error; }
  }
  close() { this.native.close(); }
}
