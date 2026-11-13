export type NeuralStatus = 'off' | 'loading' | 'ready' | 'error' | 'unsupported';

export class NeuralClient {
  status: NeuralStatus = 'unsupported';
  lastMs = 0;
  error = '';
  start(): void {}
  run(): Promise<null> {
    return Promise.resolve(null);
  }
  stop(): void {}
}
