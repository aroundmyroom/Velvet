import { AudioEngine } from '../src/audio/AudioEngine';
import { VisualizerHost, type LayerHandle } from '../src/visualizers/runtime/VisualizerHost';
import { META, UPSTREAM_VERSION } from './meta';
import cssUrl from './voltviz.css?url';

export const VERSION: string = UPSTREAM_VERSION;

const SETTINGS = { sensitivity: 1, speed: 1, hueShift: 0, scale: 1 };

export function listVisualizers(): { id: string; name: string; group: string; webgpu: boolean }[] {
  return META.map(({ id, name, group, webgpu }) => ({ id, name, group, webgpu }));
}

function resolveId(id: unknown): string {
  if (typeof id === 'string' && META.some(v => v.id === id)) return id;
  return META.find(v => !v.webgpu)!.id;
}

let cssReady: Promise<void> | null = null;
function ensureCss(): Promise<void> {
  if (!cssReady) {
    cssReady = new Promise<void>(resolve => {
      const href = new URL(cssUrl, import.meta.url).href;
      const existing = document.querySelector<HTMLLinkElement>('link[data-voltviz]');
      if (existing) return resolve();
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.voltviz = '';
      link.onload = () => resolve();
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }
  return cssReady;
}

interface Options {
  container: HTMLElement;
  audioContext: AudioContext;
  input: AudioNode;
  visualizer?: string;
  bpm?: number | null;
}

export async function createVoltViz({ container, audioContext, input, visualizer }: Options) {
  await ensureCss();
  // A private tap: tearing down only ever disconnects input -> tap, never the player's other connections.
  const tap = audioContext.createGain();
  input.connect(tap);
  const engine = await AudioEngine.fromNode(audioContext, tap, { autoGain: true, neural: false });
  const host = new VisualizerHost(engine);
  const root = document.createElement('div');
  root.className = 'voltviz-root';
  container.appendChild(root);

  let current: { id: string; handle: LayerHandle; el: HTMLDivElement } | null = null;
  let seq = 0;
  let destroyed = false;

  async function mount(id: string): Promise<void> {
    const mySeq = ++seq;
    const factory = await META.find(v => v.id === id)!.load();
    if (destroyed || mySeq !== seq) return;
    const el = document.createElement('div');
    el.className = 'voltviz-layer';
    root.appendChild(el);
    const handle = host.mount(id, el, factory, SETTINGS, null);
    await handle.ready;
    if (destroyed || mySeq !== seq) {
      handle.dispose();
      el.remove();
      return;
    }
    const prev = current;
    current = { id, handle, el };
    if (prev) {
      prev.handle.dispose();
      prev.el.remove();
    }
  }

  await mount(resolveId(visualizer));

  return {
    get visualizer(): string | null {
      return current?.id ?? null;
    },
    async setVisualizer(id: string): Promise<void> {
      if (destroyed) return;
      const next = resolveId(id);
      if (next === current?.id) return;
      await mount(next);
    },
    resize(): void {
      if (!current) return;
      current.handle.ready.then(inst => {
        if (!inst || !current) return;
        const r = current.el.getBoundingClientRect();
        inst.resize?.(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)), Math.min(window.devicePixelRatio || 1, 2));
      });
    },
    setBpm(_bpm: number | null): void {},
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      seq++;
      if (current) {
        current.handle.dispose();
        current.el.remove();
        current = null;
      }
      host.dispose();
      engine.dispose();
      try { input.disconnect(tap); } catch { /* already disconnected */ }
      root.remove();
    },
  };
}
