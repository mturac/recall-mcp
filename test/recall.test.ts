import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Configuration for testing
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.RECALL_AUTH_KEY = 'test_token_123';
process.env.PORT = '0'; // random port

// Mock the embedder BEFORE importing the app
vi.mock('../src/embedding/embedder.js', () => {
  return {
    embedder: {
      init: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockImplementation(async (text: string) => {
        // Return a deterministic 384d Float32Array dummy vector
        const vec = new Array(384).fill(0.01);
        return vec;
      })
    }
  };
});

import { app, runServer } from '../src/index.js';
import { db } from '../src/db/client.js';
import { gc } from '../src/utils/gc.js';
import { embedder } from '../src/embedding/embedder.js';

describe('RECALL-MCP v2 - SSE & Bearer Auth API', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // Clear the memory DB
    db.prepare('DELETE FROM memories').run();
    server = await runServer() as unknown as Server;
    const address = server.address() as any;
    port = address.port;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  describe('1. Authentication & Security', () => {
    it('should reject SSE connection without Authorization header', async () => {
      const res = await request(app).get('/sse');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization/);
    });

    it('should establish connection successfully WITH correct token', async () => {
      const res = await fetch(`http://localhost:${port}/sse`, {
        headers: { 'Authorization': `Bearer ${process.env.RECALL_AUTH_KEY}` }
      });
      
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      
      // Close the fetch body to prevent hanging
      await res.body?.cancel();
    });
  });

  describe('2. Database Triggers & Hybrid Search', () => {
    it('should automatically populate fts and vec tables and succeed via tool', async () => {
      // 1. Insert directly to DB (triggering auto-sync to FTS and VEC)
      const id = 'test_uuid_1';
      const info = db.prepare(`
        INSERT INTO memories (id, namespace, content, category, weight)
        VALUES (?, 'global', 'The quick brown fox', 'fact', 'STRONG')
      `).run(id);

      db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid, 
        Buffer.from(new Float32Array(384).fill(0.1).buffer)
      );

      // Verify FTS table population
      const ftsTest = db.prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?').all('fox');
      expect(ftsTest.length).toBe(1);

      // Verify VEC table population
      const vecTest = db.prepare('SELECT rowid FROM memories_vec').all();
      expect(vecTest.length).toBe(1);

      // Connect via MCP Client to test tool
      const transport = new SSEClientTransport(new URL(`http://localhost:${port}/sse`));
      // Setup auth headers for transport requests
      const originalFetch = global.fetch;
      global.fetch = async (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${process.env.RECALL_AUTH_KEY}`);
        init.headers = headers;
        return originalFetch(input, init);
      };

      const client = new Client({ name: 'test-client', version: '1.0' });
      await client.connect(transport);

      // Wait a tiny bit for the server to process the client connection
      await new Promise(r => setTimeout(r, 100));

      const result: any = await client.callTool({
        name: 'recall_search',
        arguments: {
          query: 'quick brown',
          limit: 10,
          mode: 'hybrid'
        }
      });

      expect(result.content).toBeDefined();
      const searchData = JSON.parse(result.content[0].text);
      expect(searchData.length).toBeGreaterThan(0);
      expect(searchData[0].id).toBe(id);

      // Cleanup
      global.fetch = originalFetch;
    });
  });

  describe('3. Garbage Collector & Time Travel (Memory Decay)', () => {
    it('should decay old memories except instruction, and delete expired', () => {
      // Setup initial data in the past
      db.prepare('DELETE FROM memories').run();

      // Memory A: STRONG -> MEDIUM (> 7 days)
      const insA = db.prepare(`INSERT INTO memories (id, category, weight, updated_at, content) VALUES ('m_a', 'project', 'STRONG', datetime('now', '-8 days'), 'A')`).run();
      db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(insA.lastInsertRowid, Buffer.from(new Float32Array(384).fill(0.1).buffer));
      
      const insB = db.prepare(`INSERT INTO memories (id, category, weight, updated_at, content) VALUES ('m_b', 'fact', 'MEDIUM', datetime('now', '-15 days'), 'B')`).run();
      db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(insB.lastInsertRowid, Buffer.from(new Float32Array(384).fill(0.1).buffer));
      
      const insC = db.prepare(`INSERT INTO memories (id, category, weight, updated_at, content) VALUES ('m_c', 'instruction', 'STRONG', datetime('now', '-30 days'), 'C')`).run();
      db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(insC.lastInsertRowid, Buffer.from(new Float32Array(384).fill(0.1).buffer));

      const insD = db.prepare(`INSERT INTO memories (id, category, weight, expires_at, content) VALUES ('m_d', 'general', 'WEAK', datetime('now', '-1 hour'), 'D')`).run();
      db.prepare('INSERT INTO memories_vec(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(insD.lastInsertRowid, Buffer.from(new Float32Array(384).fill(0.1).buffer));

      // Run GC manually
      gc.runCleanup();

      // Assertions
      const getWeight = (id: string) => db.prepare('SELECT weight FROM memories WHERE id = ?').get(id) as any;
      const memD = db.prepare('SELECT id FROM memories WHERE id = ?').get('m_d');

      expect(getWeight('m_a')?.weight).toBe('MEDIUM');
      expect(getWeight('m_b')?.weight).toBe('WEAK');
      expect(getWeight('m_c')?.weight).toBe('STRONG');
      
      // Memory D deleted
      expect(memD).toBeUndefined();

      // Verify triggers handled vec deletion
      const vecCount = db.prepare('SELECT count(*) as c FROM memories_vec').get() as any;
      expect(vecCount.c).toBe(3); // A, B, C remain
    });
  });
});
