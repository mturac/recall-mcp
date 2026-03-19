import { db } from '../db/client.js';

class MemoryGarbageCollector {
  private intervalId: NodeJS.Timeout | null = null;
  
  start(intervalMs = 60 * 60 * 1000) { // Default 1 hour
    if (this.intervalId) return;
    
    this.runCleanup();
    this.intervalId = setInterval(() => this.runCleanup(), intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public runCleanup() {
    try {
      db.transaction(() => {
        // 1. Hard delete expired memories
        db.prepare(`
          DELETE FROM memories 
          WHERE expires_at IS NOT NULL 
          AND expires_at < CURRENT_TIMESTAMP
        `).run();

        // 2. Downgrade STRONG to MEDIUM (> 7 days old, if not instruction/core)
        db.prepare(`
          UPDATE memories 
          SET weight = 'MEDIUM', updated_at = CURRENT_TIMESTAMP
          WHERE weight = 'STRONG' 
          AND category NOT IN ('instruction')
          AND updated_at < datetime(CURRENT_TIMESTAMP, '-7 days')
        `).run();

        // 3. Downgrade MEDIUM to WEAK (> 14 days old, if not instruction)
        db.prepare(`
          UPDATE memories 
          SET weight = 'WEAK', updated_at = CURRENT_TIMESTAMP
          WHERE weight = 'MEDIUM'
          AND category NOT IN ('instruction')
          AND updated_at < datetime(CURRENT_TIMESTAMP, '-14 days')
        `).run();
      })();
      
    } catch (err) {
      console.error('[GC Error]', err);
    }
  }
}

export const gc = new MemoryGarbageCollector();
