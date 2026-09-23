import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from './llm.service';

// Probed 2026-09: omniroute passes `input_audio` (ogg) through to antigravity/gemini-2.5-flash and it transcribes
// fine. WHISPER_URL (OpenAI-compatible /v1/audio/transcriptions) is the fallback.
@Injectable()
export class TranscribeService {
  private log = new Logger('Transcribe');
  constructor(private llm: LlmService) {}

  async transcribe(audio: Buffer, format = 'ogg'): Promise<string> {
    let omniErr = 'OMNI_KEY vacía';
    if (process.env.OMNI_KEY) {
      try {
        const text = await this.llm.chat([{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe este audio en español, literal. Sólo la transcripción, sin comillas ni comentarios.' },
            { type: 'input_audio', input_audio: { data: audio.toString('base64'), format } },
          ],
        }], this.llm.model, 500);
        return text.trim();
      } catch (e) {
        omniErr = (e as Error).message;
        this.log.warn(`omniroute audio falló: ${omniErr}`);
      }
    }
    const url = process.env.WHISPER_URL;
    if (!url) throw new Error(`La voz no está configurada (omniroute: ${omniErr.slice(0, 200)})`);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: `audio/${format}` }), `voice.${format}`);
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const r = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`whisper ${r.status}`);
    return String(((await r.json()) as any).text ?? '').trim();
  }
}
