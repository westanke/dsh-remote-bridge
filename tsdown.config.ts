import { defineConfig } from 'tsdown'

const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

// Two entries, not three.
//
// The `standalone` entry (the `/dsh-workspace` page) was removed in 2.2.0: the desktop file tree had
// already moved out of the settings panel in 2.0.4, so that page was the last consumer of CodeMirror
// and of `assets/workspace.html`. Dropping it took the tarball from 1.72 MB to 0.25 MB.
//
// `sourcemap` is off on purpose. The maps were ~5 MB of the published package and nobody could use
// them: this plugin ships pre-built bundles, and a consumer debugging a crash inside `client.cjs`
// needs the original TypeScript sources, which are not in the tarball either way.
export default defineConfig([
  {
    name: 'dsh-remote-bridge/host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: true,
    fixedExtension: false,
    clean: false,
  },
  {
    name: 'dsh-remote-bridge/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: clientExternals,
      alwaysBundle: (id: string) => clientExternals.includes(id) ? undefined : true,
      onlyBundle: false,
    },
    outputOptions: {
      entryFileNames: 'client.cjs',
      banner: "window.__ModuleLoader__.load({ id: 'dsh-remote-bridge', factory: (require) => {",
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
