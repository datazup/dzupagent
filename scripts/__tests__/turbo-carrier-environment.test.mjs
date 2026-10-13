import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const turbo = require.resolve('@turbo/linux-64/bin/turbo')
const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../turbo.json', import.meta.url)), 'utf8'))

test('strict Turbo tasks preserve the qualified private Yarn install-state path', t => {
  const root = fs.mkdtempSync('/data/storage/datazup-runtime/ninel/evidence/turbo-carrier-environment-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const deadline = Date.now() + 60000
  for (const name of ['bin', 'home', 'tmp', 'cache']) fs.mkdirSync(path.join(root, name), { mode: 0o700 })
  // Actual Turbo filters the environment before this bounded fake transport.
  // No Yarn install/Corepack/network is needed to observe that boundary.
  fs.writeFileSync(root + '/bin/yarn', "#!/usr/bin/node\nconst args=process.argv.slice(2);if(args.length===1&&args[0]==='--version')console.log('4.16.0');else if(args.length===2&&args[0]==='run'&&args[1]==='build'){const {spawnSync}=require('node:child_process');const r=spawnSync('/usr/bin/node',['env-probe.mjs'],{stdio:'inherit'});process.exitCode=r.status??70;}else process.exitCode=70;\n", { mode: 0o700 })
  const expected = root + '/tmp/install-state.gz'
  for (const retained of [false, true]) {
    const fixture = path.join(root, retained ? 'retained' : 'filtered')
    fs.mkdirSync(fixture, { mode: 0o700 })
    const save = (name, value) => fs.writeFileSync(path.join(fixture, name), value, { flag: 'wx', mode: 0o600 })
    save('package.json', JSON.stringify({ name: 'turbo-env-fixture', private: true, packageManager: 'yarn@4.16.0', scripts: { build: '/usr/bin/node env-probe.mjs' } }))
    save('yarn.lock', '__metadata:\n  version: 8\n')
    save('.yarnrc.yml', 'enableNetwork: false\n')
    save('turbo.json', JSON.stringify({ noUpdateNotifier: true, tasks: { build: { cache: false } },
      globalPassThroughEnv: retained ? config.globalPassThroughEnv : config.globalPassThroughEnv.filter(name => name !== 'YARN_INSTALL_STATE_PATH') }))
    save('env-probe.mjs', `import fs from 'node:fs';if(Date.now()>=${deadline})process.exit(70);fs.writeFileSync('observed.json',JSON.stringify({statePath:process.env.YARN_INSTALL_STATE_PATH??null}),{flag:'wx',mode:0o600});\n`)
    const result = spawnSync(turbo, ['run', 'build', '--single-package', '--force', '--concurrency=1', '--no-daemon'], {
      cwd: fixture, encoding: 'utf8', timeout: Math.max(1, Math.min(30000, deadline - Date.now())), maxBuffer: 65536,
      env: { PATH: root + '/bin:/usr/bin:/bin', HOME: root + '/home', TMPDIR: root + '/tmp', XDG_CACHE_HOME: root + '/cache',
        TURBO_TELEMETRY_DISABLED: '1', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', YARN_ENABLE_NETWORK: '0', YARN_INSTALL_STATE_PATH: expected },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture + '/observed.json', 'utf8')), { statePath: retained ? expected : null })
  }
})
