import { pipeline, env } from '@xenova/transformers';

// Keep models local, skip cache downloads if possible
env.allowRemoteModels = true; 
env.localModelPath = './models';

class Embedder {
  private extractor: any = null;

  async init() {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        quantized: true,
      });
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.extractor) await this.init();
    
    const output = await this.extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }
}

export const embedder = new Embedder();
