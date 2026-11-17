import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })
const common = { bundle: true, target: 'es2020', legalComments: 'none', logLevel: 'warning' }

await build({ ...common, entryPoints: ['src/auto.ts'], outfile: 'dist/wgo.js', format: 'iife', globalName: 'WGO', minify: true })
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs', format: 'esm' })
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' })

const raw = readFileSync('dist/wgo.js')
const gz = gzipSync(raw, { level: 9 }).length
console.log(`dist/wgo.js: ${raw.length} bytes minified, ${gz} bytes gzipped (${(gz / 1024).toFixed(2)} KB)`)
if (gz > 10 * 1024) { console.error('Over the 10 KB gzip budget'); process.exit(1) }
