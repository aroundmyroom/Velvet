import tailwindcss from '@tailwindcss/vite';
import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// The minifier drops license comments, so ship the license text of every bundled npm package.
function bundledLicenses(): Plugin {
  return {
    name: 'velvet-bundled-licenses',
    apply: 'build',
    generateBundle(_, bundle) {
      const packages = new Map<string, string>();
      for (const out of Object.values(bundle)) {
        const ids = 'moduleIds' in out ? out.moduleIds : [];
        for (const id of ids) {
          const p = id.split('?')[0].replace(/\\/g, '/');
          const i = p.lastIndexOf('/node_modules/');
          if (i < 0) continue;
          const parts = p.slice(i + 14).split('/');
          const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
          packages.set(name, p.slice(0, i + 14) + name);
        }
      }
      const sections = [...packages].sort(([a], [b]) => a.localeCompare(b)).map(([, dir]) => {
        const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
        const texts = readdirSync(dir).filter(f => /^(licen[cs]e|notice|copying)/i.test(f)).sort()
          .map(f => readFileSync(`${dir}/${f}`, 'utf8').trim());
        return `${'-'.repeat(80)}\n${pkg.name}@${pkg.version} (${pkg.license})\n\n${texts.join('\n\n') || '(no license text found)'}\n`;
      });
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: `npm packages bundled in this build\n${'='.repeat(80)}\n\n${sections.join('\n')}`,
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname + '/..',
  base: './',
  publicDir: false,
  logLevel: 'warn',
  plugins: [tailwindcss(), bundledLicenses()],
  build: {
    outDir: 'velvet/dist',
    emptyOutDir: true,
    sourcemap: false,
    copyPublicDir: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { voltviz: 'velvet/voltviz.ts' },
      preserveEntrySignatures: 'strict',
      treeshake: { moduleSideEffects: id => !/[\\/]node_modules[\\/](react|react-dom|lucide-react)[\\/]|lib[\\/]imageUpload\.tsx$/.test(id) },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: { entryFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});
