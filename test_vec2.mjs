import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
const db = new Database(':memory:');
sqliteVec.load(db);
db.exec('CREATE TABLE foo (id TEXT PRIMARY KEY);');
db.exec('CREATE VIRTUAL TABLE foo_vec USING vec0(embedding float[1]);');
const result = db.prepare("INSERT INTO foo (id) VALUES ('abc')").run();
try {
  let r = typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid;
  db.prepare('INSERT INTO foo_vec(rowid, embedding) VALUES (cast(? as integer), ?)').run(r, Buffer.from(new Float32Array([1]).buffer));
  console.log("Success with CAST!");
} catch (e) {
  console.log("Failed with CAST:", e.message);
  try {
    let r = typeof result.lastInsertRowid === 'bigint' ? result.lastInsertRowid.toString() : result.lastInsertRowid.toString();
    db.prepare('INSERT INTO foo_vec(rowid, embedding) VALUES (?, ?)').run(r, Buffer.from(new Float32Array([1]).buffer));
    console.log("Success with BigInt.toString()!");
  } catch(e2) {
    console.log("Failed with BigInt.toString():", e2.message);
  }
}
